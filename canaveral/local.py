"""Isolated loopback controller, dashboard and optional installed Android runner."""
import json
import logging
import os
import secrets
import signal
import threading
import time
import subprocess
import contextlib
import platform
import sqlite3
from pathlib import Path

from .api import server as api_server
from .dashboard import server as dashboard_server
from .files import HostLock, save_json
from .host import Agent
from .lease_clock import contact_fresh
from .model import Error
from .providers.base import architecture
from .store import Store
from .templates import load_host


def physical_host(root,paths,store,url):
    """Reuse fenced local runtime state beneath one physical host identity."""
    destination=root/'machine-host.json'
    if destination.exists():
        config=load_host(json.loads(destination.read_text()),root)
        return config,Path(config['agentStateDirectory'])
    configs=[(path,load_host(json.loads(path.read_text()),root)) for path in paths if path.exists()]
    if not configs:return None
    system={'Darwin':'macos','Linux':'linux','Windows':'windows'}[platform.system()]
    definition={'name':'local-'+system,'provider':system,'storage':str(root/'machines'),
                'pollIntervalSeconds':.25,'capacity':{'cpu':0,'memoryMiB':0,'diskGiB':0},'runtimes':{},'templates':[]}
    offered=[];identities=[]
    with contextlib.ExitStack() as locks:
        for path,config in configs:
            state=root/('linux-agent' if path.name=='linux-host.json' else 'agent')
            state.mkdir(mode=0o700,parents=True,exist_ok=True)
            locks.enter_context(HostLock(state/'agent.lock'))
            settings={key:value for key,value in config.items() if key not in ('name','provider','capacity','templates','pollIntervalSeconds','offerTemplateRevisions')}
            settings['stateDirectory']=str(state)
            definition['runtimes'][config['provider']]=settings
            definition['templates'].extend(config['templates'])
            for key in definition['capacity']:definition['capacity'][key]+=config['capacity'][key]
            offered.extend(config.get('offerTemplateRevisions',[item['id']+'@'+item['revision']+':'+item['arch'] for item in config['templates']]))
            identity_path=state/'identity.json'
            if identity_path.exists():
                identity=json.loads(identity_path.read_text())
                if identity['orchestrator']!=url:raise Error('Local runtime state belongs to another controller.')
                identities.append((state,identity))
        definition['offerTemplateRevisions']=offered
        canonical_state=identities[0][0] if identities else root/'agent'
        definition['agentStateDirectory']=str(canonical_state)
        if identities:
            backup=root/'before-physical-host.sqlite3'
            if not backup.exists():
                with sqlite3.connect(store.path) as source,sqlite3.connect(str(backup)) as copy:source.backup(copy)
                os.chmod(backup,0o600)
            store.consolidate_local_runtimes(identities[0][1]['id'],[value['id'] for _,value in identities[1:]],definition)
        save_json(destination,definition)
    return definition,canonical_state


def run(directory, api_port, dashboard_port, android_sdk=None, linux_image=None, apple_runner=None):
    root = Path(directory).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if api_port == dashboard_port or not all(0 < port < 65536 for port in (api_port, dashboard_port)):
        raise Error("Use distinct valid API and dashboard ports.", 400)
    with HostLock(root / "local.lock"):
        credentials = root / "credentials.json"
        if not credentials.exists():
            save_json(credentials, {"admin": secrets.token_urlsafe(32), "enrollment": secrets.token_urlsafe(32)})
        tokens = json.loads(credentials.read_text())
        url = "http://127.0.0.1:" + str(api_port)
        store = Store(root / "controller.sqlite3")
        agents = []
        def image_import_connector(host_id,metadata=None,reader=None,size=None,authorized=None,check_only=False):
            agent=next((current for current in agents if current.identity['id']==host_id),None)
            if not agent or agent.stopping.is_set() or not contact_fresh(agent.last_contact):raise Error('Image host is not attached and connected.',409)
            if check_only:return True
            metadata,_,_=agent.image_import_settings(metadata)
            try:
                with HostLock(agent.library.root/(metadata['id']+'.upload.lock')):
                    store.reserve_image_import(host_id,metadata,size)
                    try:
                        public=agent.import_image(metadata,reader,size,authorized)
                        store.finish_image_import(metadata['id'],host_id,result=public)
                    except Error as error:
                        published=any(record['id']==metadata['id'] for record in agent.library.public_records())
                        if error.status in (400,403) and not published:
                            store.finish_image_import(metadata['id'],host_id,failed=True)
                        raise
                    agent.library.acknowledge({public['id']:public['sha256']})
                    agent.refresh_images()
                    return public
            except RuntimeError:
                raise Error('This image import is already in progress; inspect its task before retrying.',409)
        def attached(machine_id, established=False):
            machine = next((m for m in store.machines() if m["id"] == machine_id), None)
            agent = next((a for a in agents if machine and a.identity["id"] == machine["hostId"]), None)
            if not machine or not agent or machine["desired"] != "running" or (not established and machine["observed"] != "running") or agent.stopping.is_set() or not contact_fresh(agent.last_contact):
                raise Error("Environment is not running on an attached, connected host.",409)
            if not agent.lease_guard.allowed(machine_id):raise Error('Lease execution is fenced.',410)
            if machine.get('lease'):agent.lease_guard.begin_execution(machine_id,machine['lease']['id'])
            runtime,image,folder=agent.context(machine)
            return machine,runtime,image,folder
        def desktop_connector(machine_id, check_only=False):
            try:
                machine,runtime,image,folder=attached(machine_id, established=check_only)
                if not (runtime.access or image['os'] in ('android','ios')):
                    raise Error('This provider has no display connection.',409)
                if check_only:return True
                from .display_access import DisplayEndpoint
                from .providers.mobile import operation_receipt
                from .assignment_gate import assignment_access
                authorized=lambda:desktop_connector(machine_id,check_only=True)
                if runtime.access:factory=lambda:runtime.access.desktop(machine,image,folder)
                else:
                    from .simulator_screen import connect
                    factory=lambda:connect(runtime,machine,image,folder,authorized)
                agent=next(a for a in agents if a.identity['id']==machine['hostId'])
                return DisplayEndpoint(agent.display_controls,machine_id,factory,authorized,
                    lambda:runtime.display_epoch(machine,image,folder),
                    action_handler=lambda request:runtime.operate(machine,image,folder,
                        {**request,'machineId':machine_id,'expiresAt':time.time()+30}),
                    receipt_handler=lambda operation_id:operation_receipt(folder,operation_id),
                    resource_gate=lambda:assignment_access(machine,folder))
            except Error:
                if check_only:return False
                raise
        def upload_connector(machine_id,path=None,app=None,reader=None,size=None,authorized=None,check_only=False):
            machine,runtime,image,folder=attached(machine_id, established=check_only)
            if check_only:return True
            from .assignment_gate import assignment_access
            with assignment_access(machine,folder):
                if runtime.access:
                    return runtime.access.stream_upload(machine,image,folder,path,app,reader,size,authorized)
                if hasattr(runtime,"stream_upload"):
                    return runtime.stream_upload(machine,image,folder,path,app,reader,size,authorized)
            raise Error("This provider has no streaming file connection.",409)
        def download_connector(machine_id,path=None,app=None,check_only=False):
            machine,runtime,image,folder=attached(machine_id, established=check_only)
            if check_only:return True
            from .assignment_gate import assignment_access,GatedSource
            gate=assignment_access(machine,folder);gate.__enter__()
            try:
                if runtime.access:source=runtime.access.stream_download(machine,image,folder,path,app)
                elif hasattr(runtime,"stream_download"):source=runtime.stream_download(machine,image,folder,path,app)
                else:raise Error("This provider has no streaming download connection.",409)
                return GatedSource(source,gate)
            except BaseException:
                gate.__exit__(None,None,None);raise
        def shell_connector(machine_id, request=None, check_only=False):
            machine,runtime,image,folder=attached(machine_id,established=True)
            if not (image['os']=='android' or image.get('guestAccess')):
                raise Error('This environment has no interactive shell.',409)
            if check_only:return True
            from .assignment_gate import assignment_access
            with assignment_access(machine,folder):
                if image['os']=='android':
                    # The existing PTY is pinned to its owned adb process. It cannot
                    # switch targets; avoid SDK subprocesses for every keystroke/read.
                    return runtime.shells.control(machine_id,request['action'],request['arguments'])
                return runtime.control(machine,image,folder,request)
        def accessibility_connector(machine_id):
            from .accessibility import inspect_provider
            machine,runtime,image,folder=attached(machine_id)
            from .assignment_gate import assignment_access
            with assignment_access(machine,folder):return inspect_provider(runtime,machine,image,folder,include_frame=False)
        api = api_server(store, ("127.0.0.1", api_port), tokens["admin"], tokens["enrollment"])
        try:
            dashboard = dashboard_server(("127.0.0.1", dashboard_port), url, bootstrap_token=tokens["admin"], reload_assets=True, desktop_connector=desktop_connector, upload_connector=upload_connector, accessibility_connector=accessibility_connector, download_connector=download_connector, shell_connector=shell_connector,image_import_connector=image_import_connector)
        except Exception:
            api.server_close()
            raise
        stop = threading.Event()
        agent = None
        threads = []
        try:
            for service in (api, dashboard):
                thread = threading.Thread(target=service.serve_forever, daemon=True)
                thread.start()
                threads.append(thread)
            config_path = root / "host.json"
            if android_sdk and not config_path.exists():
                sdk = Path(android_sdk).expanduser().resolve()
                abi = "arm64-v8a" if architecture() == "arm64" else "x86_64"
                images = sorted((sdk / "system-images").glob("*/*/" + abi))
                if not images:
                    raise Error("No installed Android system image for this host architecture. Install one or omit --android-sdk.")
                image = images[-1]
                save_json(config_path, {
                    "name": "local-android", "provider": "android", "pollIntervalSeconds": 0.25,
                    "capacity": {"cpu": 4, "memoryMiB": 8192, "diskGiB": 64},
                    "androidSDK": str(sdk), "storage": str(root / "devices"),
                    "templates": [{"id": "local-android", "revision": "1", "os": "android", "mode": "device",
                                   "arch": architecture(), "device": {"systemImage": ";".join(image.relative_to(sdk).parts), "profile": "pixel_8"},
                                   "minimum": {"cpu": 2, "memoryMiB": 2048, "diskGiB": 8}}]})
            linux_path = root / "linux-host.json"
            if linux_image and not linux_path.exists():
                if not apple_runner:
                    raise Error("Supply --apple-runner with the installed signed runner.")
                from .guest_access import desktop_recipe
                key = root / "desktop_ed25519"
                if not key.exists():
                    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
                save_json(linux_path, {
                    "name": "local-linux", "provider": "apple", "pollIntervalSeconds": 0.25,
                    "runner": str(Path(apple_runner).expanduser().resolve()),
                    "storage": str(root / "linux-disks"), "guestOrchestratorURL": "http://192.168.64.1:" + str(api_port),
                    "guestAccess": {"identityFile": str(key)},
                    "capacity": {"cpu": 4, "memoryMiB": 8192, "diskGiB": 128},
                    "templates": [{"id": "ubuntu-desktop", "revision": "1", "os": "linux", "mode": "desktop", "arch": "arm64",
                                   "image": str(Path(linux_image).expanduser().resolve()), "guestAccess": True,
                                   "minimum": {"cpu": 2, "memoryMiB": 4096, "diskGiB": 32}, "memoryStepMiB": 1024,
                                   "prepare": desktop_recipe(Path(str(key)+".pub").read_text().strip())}]
                })
            physical=physical_host(root,(config_path,linux_path),store,url)
            for config,state in ([physical] if physical else []):
                agent = Agent(config, url, state, allow_http=True)
                agent.connect(tokens["enrollment"])
                agents.append(agent)
                def worker(current=agent):
                    try:
                        current.run(tokens["enrollment"])
                    except Exception:
                        logging.exception("Local host stopped")
                        stop.set()
                thread = threading.Thread(target=worker, daemon=True)
                thread.start()
                threads.append(thread)
            for signum in (signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, lambda *_: stop.set())
            logging.info("Local dashboard: http://127.0.0.1:%s", dashboard_port)
            logging.info("Persistent local state: %s", root)
            if not agents:
                logging.info("No local host configured. Pass --android-sdk or configure %s", config_path)
            stop.wait()
        finally:
            for agent in agents:
                agent.stopping.set()
            for service in (dashboard, api):
                service.shutdown()
                service.server_close()
            for thread in threads:
                thread.join(timeout=5)
            logging.info("Local services stopped. Device disks and running devices are retained; stop devices in the dashboard before shutting down.")
