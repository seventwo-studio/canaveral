import json
import copy
import logging
import secrets
import threading
import time
import uuid
from pathlib import Path

from .client import Client
from .files import HostLock, save_json
from .lease_clock import contact_fresh,execution_monotonic
from .model import Error, digest, offer, template
from .preparation import credential, user_data, prepare_ssh
from .templates import prepare_image
from .providers import provider_for


class Agent:
    def __init__(self, config, url, state_dir, allow_http=False, ca_file=None):
        config=dict(config)
        if 'leaseProtocol' in config or 'leaseImages' in config:
            raise Error('This runner cannot advertise lease execution until session cancellation and owned cleanup are implemented.',400)
        self.state_dir = Path(state_dir).resolve()
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        from .image_library import ImageLibrary
        self.library=ImageLibrary(self.state_dir)
        from .lease_guard import LeaseGuard
        self.lease_guard=LeaseGuard(self.state_dir)
        from .display_access import DisplayControls
        self.display_controls=DisplayControls(self.state_dir/'display-controls.json')
        imported=self.library.definitions()
        config['templates']=[*config['templates'],*imported]
        self.config=config
        self.offer = offer(config)
        offered = config.get("offerTemplateRevisions")
        if offered is not None:
            if not isinstance(offered, list) or any(not isinstance(key, str) for key in offered):
                raise Error("offerTemplateRevisions must contain image revision keys.")
            available = {item["id"] + "@" + item["revision"] + ":" + item["arch"] for item in self.offer["templates"]}
            if not offered or set(offered) - available:
                raise Error("Offered image revisions must be installed on this host.")
            offered=[*offered,*[item['id']+'@'+item['revision']+':'+item['arch'] for item in imported]]
            self.offer["templates"] = [item for item in self.offer["templates"] if item["id"] + "@" + item["revision"] + ":" + item["arch"] in offered]
        self.provider = provider_for(config, self.state_dir)
        self.url, self.allow_http = url, allow_http
        self.ca_file=ca_file
        self.lock = threading.Lock()
        self.assignments, self.reports = [], {}
        self.inference_jobs, self.inference_reports = [], {}
        self.device_operations, self.device_reports = [], {}
        self.image_tasks,self.image_reports=[],{}
        self.inference_runner = None
        if "inference" in self.offer:
            from .inference_runner import InferenceRunner
            self.inference_runner = InferenceRunner(config["inference"], self.state_dir, self.offer["inference"]["models"])
        self.last_contact = 0
        interval = config.get("pollIntervalSeconds", 5)
        if type(interval) not in (int, float) or not 0.25 <= interval <= 5:
            raise Error("pollIntervalSeconds must be between 0.25 and 5.")
        self.poll_interval = interval
        self.stopping = threading.Event()
        self.access_sessions=[]
        from .runner_sessions import RunnerSessions
        self.access_runner=RunnerSessions(self)
        from .native_lease import NativeLeaseUpdates
        self.native_lease_updates=NativeLeaseUpdates(self)
        from .lease_cleanup import LeaseCleanupRunner
        self.cleanup_runner=LeaseCleanupRunner(self)
        self.health = None
        self.check_requested = threading.Event()
        self.last_check_request = 0
        self.resource_sample = None
        self.last_resource_sample = 0
        self.resource_generation=0
        self.resource_worker=None
        self.cluster_report = None

    def connect(self, enrollment_token):
        # Validate local trust configuration before persisting a new identity.
        client=Client(self.url,'',self.allow_http,ca_file=self.ca_file)
        enrollment=Client(self.url,enrollment_token,self.allow_http,ca_file=self.ca_file) if enrollment_token else None
        path = self.state_dir / "identity.json"
        if path.exists():
            identity = json.loads(path.read_text())
            if identity["orchestrator"] != self.url.rstrip("/"):
                raise Error("This host identity belongs to another orchestrator; use a separate state directory.")
        else:
            if not enrollment_token:
                raise Error("A new host needs an enrollment credential file.")
            identity = {"id": str(uuid.uuid4()), "credential": secrets.token_urlsafe(32), "orchestrator": self.url.rstrip("/")}
            # Persist before enrolling so a lost enrollment response can be retried safely.
            save_json(path, identity)
        self.identity = identity
        client.token=identity['credential'];self.client=client
        if enrollment:
            enrollment.request("POST", "/v1/hosts/enroll", {**identity, "offer": self.offer})

    def poll(self):
        infrastructure={}
        with self.lock:
            reports = dict(self.reports)
            device_reports = dict(list(self.device_reports.items())[:1])
            # Bound large generation results; acknowledge one inference report per heartbeat.
            inference_reports = {} if device_reports else dict(list(self.inference_reports.items())[:1])
            image_reports=dict(list(self.image_reports.items())[:1])
            for job_id in inference_reports:
                self.inference_reports[job_id] = self.inference_reports.pop(job_id)
            if self.health is not None:
                infrastructure={'health':self.health}
                if self.resource_sample is not None:
                    infrastructure['resources']=self.resource_sample
        sent=execution_monotonic()
        response = self.client.request("POST", "/v1/hosts/" + self.identity["id"] + "/heartbeat",
                                       {"offer": self.offer, "reports": reports, "inferenceReports": inference_reports,
                                        "deviceReports": device_reports,'imageReports':image_reports,
                                        'installedImages':[template(image) for image in self.config['templates']], **infrastructure})
        self.lease_guard.observe(response['machines'],execution_monotonic()-sent)
        active_ids={machine['id'] for machine in response['machines']}
        for machine_id,report in reports.items():
            cleanup=report.get('leaseCleanup')
            if machine_id not in active_ids and cleanup and cleanup.get('state')=='complete':
                self.lease_guard.retire(machine_id,cleanup['leaseId'],cleanup['id'])
        self.library.acknowledge(response.get('imageAcknowledged',{}))
        self.refresh_images()
        if response.get('checksRequestedAt',0) > self.last_check_request:
            self.last_check_request = response['checksRequestedAt']
            self.check_requested.set()
        with self.lock:
            # Start freshness at request dispatch. Network delay, host sleep and
            # local response processing must not make an old offer look new.
            self.assignments, self.last_contact = response["machines"], sent
            active_machines={machine['id'] for machine in self.assignments}
            for machine_id in reports:
                if machine_id not in active_machines:self.reports.pop(machine_id,None)
            self.inference_jobs = response.get("inferenceJobs", [])
            self.device_operations = response.get("deviceOperations", [])
            self.access_sessions=response.get('accessSessions',[])
            self.image_tasks=response.get('imageTasks',[])
            image_active={job['id'] for job in self.image_tasks}
            for task_id in image_reports:
                if task_id not in image_active:self.image_reports.pop(task_id,None)
            active = {operation["id"] for operation in self.device_operations}
            for operation_id in device_reports:
                if operation_id not in active:
                    self.device_reports.pop(operation_id, None)
            assigned = {job["id"] for job in self.inference_jobs}
            for job_id in inference_reports:
                if job_id not in assigned:
                    self.inference_reports.pop(job_id, None)

    def refresh_images(self):
        from .runtime_config import runtime_for
        definitions=self.library.definitions()
        with self.lock:
            existing={(item['id'],item['revision'],item['arch']):item for item in self.config['templates']}
            for definition in definitions:
                key=(definition['id'],definition['revision'],definition['arch'])
                if key in existing:
                    if template(existing[key])!=template(definition):raise Error('Local image catalogue conflicts with an installed immutable definition.')
                    continue
                self.config['templates'].append(definition)
                if self.config['provider'] in ('macos','linux','windows'):
                    runtime=self.provider.runtimes[runtime_for(self.config,definition)]
                    runtime.config['templates'].append(definition)
                self.offer={**self.offer,'templates':[*self.offer['templates'],template(definition)]}

    def image_import_settings(self,metadata):
        from .image_library import specification
        from .runtime_config import runtime_for
        metadata=specification(metadata)
        if self.config['provider'] in ('macos','linux','windows'):
            runtime=self.provider.runtimes[runtime_for(self.config,metadata)]
        else:runtime=self.provider
        compatible={'apple':('linux','macos'),'libvirt':('linux','windows'),'hyperv':('linux','windows')}
        if metadata['os'] not in compatible.get(runtime.config['provider'],()):raise Error('This runtime cannot provision the selected image OS.')
        from .providers.base import architecture
        if metadata['arch']!=architecture():raise Error('Image architecture must match this native host.',400)
        if runtime.config['provider']=='apple':
            if metadata['minimum']['memoryMiB']%1024:raise Error('Apple VM memory must use whole GiB.',400)
            if metadata['os']=='macos' and metadata['format']!='ipsw':raise Error('Import a macOS restore image first; installed macOS disks need platform artifacts.',409)
            if metadata['os']=='linux' and metadata['format'] not in ('iso','raw','qcow2'):raise Error('Apple Linux VMs require an ISO, raw or standalone QCOW2 image.',400)
        if runtime.config['provider']=='hyperv' and metadata['format']!='vhdx':raise Error('Hyper-V import currently requires an installed VHDX disk.',409)
        prepare=None
        if metadata.get('guestAccess'):
            settings=runtime.config.get('guestAccess',{})
            if not settings.get('identityFile'):raise Error('Configure the Linux guest-access identity on this host before importing an automatic guest-access image.')
            from .guest_access import guest_recipe
            prepare=guest_recipe(Path(settings['identityFile']+'.pub').read_text().strip(),metadata['mode'])
        return metadata,prepare,1024 if runtime.config['provider']=='apple' else 1

    def import_image(self,metadata,reader,size,authorized):
        metadata,prepare,step=self.image_import_settings(metadata)
        return self.library.import_stream(metadata,reader,size,authorized,prepare=prepare,memory_step=step)

    def image_work(self):
        while not self.stopping.wait(.25):
            with self.lock:
                jobs=list(self.image_tasks)
                connected=contact_fresh(self.last_contact)
            if not connected:continue
            for job in jobs:
                with self.lock:
                    if self.stopping.is_set() or not contact_fresh(self.last_contact):break
                    if self.image_reports.get(job['id'],{}).get('state') in ('succeeded','failed','unknown'):continue
                if job['kind']=='registry':
                    with self.lock:self.image_reports[job['id']]={'state':'running'}
                    try:report=self.registry_import(job)
                    except Exception:
                        report={'state':'unknown','result':{'detail':'Registry receipt or storage requires inspection; its reservation is retained.'}}
                elif job['kind']=='import':
                    result=next((record for record in self.library.public_records() if record['id']==job['id']),None)
                    if result is None:continue
                    report={'state':'succeeded','result':result}
                else:
                    with self.lock:self.image_reports[job['id']]={'state':'running'}
                    try:
                        runtime,image,folder=self.context(job['machine'])
                        import copy
                        captured=copy.deepcopy(image)
                        # Configured application state is already on disk. Only
                        # per-instance access provisioning belongs in new clones;
                        # replaying the source's install/custom commands can erase it.
                        captured.pop('prepare',None)
                        if image.get('guestAccess'):
                            from .guest_access import guest_recipe
                            identity=runtime.config['guestAccess']['identityFile']
                            captured['prepare']=guest_recipe(Path(identity+'.pub').read_text().strip(),image['mode'])
                            captured['prepare']['packages']=[]
                        report=self.library.capture(job,runtime,captured,folder)
                    except Exception:
                        report={'state':'unknown','result':{'detail':'Capture requires inspection of its host receipt; storage remains reserved.'}}
                with self.lock:self.image_reports[job['id']]=report

    def registry_import(self,job):
        from .image_registry import entry,resolve,open_source
        receipt=self.library.root/(job['id']+'.registry.receipt')
        published=next((r for r in self.library.public_records() if r['id']==job['id']),None)
        if published:return {'state':'succeeded','result':published}
        if receipt.exists():
            previous=json.loads(receipt.read_text())
            return previous.get('report',{'state':'unknown','result':{'detail':'Registry import was interrupted. Inspect its private receipt and partial files before recovery.'}})
        try:
            metadata,prepare,step=self.image_import_settings(job['metadata'])
            if self.config['provider'] in ('macos','linux','windows'):
                from .runtime_config import runtime_for
                runtime=self.provider.runtimes[runtime_for(self.config,metadata)]
            else:runtime=self.provider
            if not job.get('source'):
                source=resolve(entry(job['registryId']),runtime)
                path='/v1/hosts/'+self.identity['id']+'/image-tasks/'+job['id']+'/resolve'
                job=self.client.request('POST',path,source)
            source=job['source']
            provenance={'id':job['registryId'],'version':source['version'],'url':source['url'],'publisherSha256':source['sha256']}
            with HostLock(self.library.root/(job['id']+'.upload.lock')):
                save_json(receipt,{'started':True,'source':source})
                def authorized():
                    with self.lock:return not self.stopping.is_set() and contact_fresh(self.last_contact) and any(t['id']==job['id'] for t in self.image_tasks)
                # Identical content already registered on this host needs no second network copy.
                existing=self.library.root/(str(source['sha256'])+'.'+metadata['format']) if source['sha256'] else None
                if existing and existing.is_file():
                    with existing.open('rb') as reader:
                        public=self.library.import_stream(metadata,reader,source['bytes'],authorized,prepare=prepare,memory_step=step,expected_sha256=source['sha256'],registry=provenance)
                else:
                    with open_source(source['url']) as reader:
                        public=self.library.import_stream(metadata,reader,source['bytes'],authorized,prepare=prepare,memory_step=step,expected_sha256=source['sha256'],registry=provenance)
                report={'state':'succeeded','result':public}
        except Exception as error:
            published=any(r['id']==job['id'] for r in self.library.public_records())
            uncertain=published or (receipt.exists() and not isinstance(error,Error))
            report={'state':'unknown' if uncertain else 'failed','result':{'detail':str(error)[:500] if isinstance(error,Error) else 'Registry import needs inspection of publisher availability and private host receipts.'}}
        save_json(receipt,{'source':job.get('source'),'report':report})
        return report

    def inference_cancelled(self, job_id):
        with self.lock:
            return (self.stopping.is_set() or not contact_fresh(self.last_contact) or
                    any(job["id"] == job_id and job["desired"] == "cancelled" for job in self.inference_jobs))

    def inference_work(self):
        from .inference import TERMINAL
        while not self.stopping.wait(1):
            with self.lock:
                jobs = list(self.inference_jobs)
                reports = dict(self.inference_reports)
                connected = contact_fresh(self.last_contact)
            if not connected or any(report["state"] == "unknown" for report in reports.values()):
                continue
            # Confirm queued cancellations promptly, then preserve FIFO for execution.
            jobs.sort(key=lambda job: job["desired"] != "cancelled")
            for job in jobs:
                if reports.get(job["id"], {}).get("state") in TERMINAL:
                    continue
                def started():
                    with self.lock:
                        self.inference_reports[job["id"]] = {"state": "running"}
                try:
                    report = self.inference_runner.reconcile(job, lambda: self.inference_cancelled(job["id"]), started)
                except Exception:
                    report = {"state": "unknown", "detail": "Inference runner state is uncertain; inspect its local receipt."}
                with self.lock:
                    self.inference_reports[job["id"]] = report
                break

    def image(self, machine):
        key = (machine["templateId"], machine["template"]["revision"], machine["template"]["arch"])
        image = next((item for item in self.config["templates"] if (item["id"], item["revision"], item["arch"]) == key), None)
        if not image or template(image) != template(machine["template"]):
            raise Error("Assigned template revision or capability no longer matches this host.")
        return image

    def context(self,machine):
        image=self.image(machine)
        folder=self.state_dir/'machines'/machine['id']
        if self.config['provider'] in ('macos','linux','windows'):
            return self.provider.runtime_context(machine,image,folder)
        return self.provider,image,folder

    def runtime_providers(self):
        return list(self.provider.runtimes.values()) if self.config['provider'] in ('macos','linux','windows') else [self.provider]

    def owned_resource_processes(self,psutil):
        with self.lock:assignments=list(self.assignments)
        processes=[];unavailable=set()
        for machine in assignments:
            category='simulators' if machine.get('template',{}).get('os') in ('android','ios') else 'virtualMachines'
            try:
                runtime,image,folder=self.context(machine)
                if hasattr(runtime,'resource_processes'):
                    processes.extend(runtime.resource_processes(machine,image,folder,psutil))
                elif machine.get('observed')!='stopped':
                    # A daemon-owned runtime can survive outside our process
                    # tree. No collector is not evidence of zero owned usage.
                    unavailable.add(category)
            except Exception:
                # A failed identity lookup cannot turn an expected VM into zero
                # usage. Never expose private paths or provider stderr here.
                unavailable.add(category)
        return processes,unavailable

    def sweep_connections(self,active):
        for runtime in self.runtime_providers():
            if hasattr(runtime,'shells'):runtime.shells.sweep(active=active)
            if runtime.access:runtime.access.sweep(active)

    def reconcile(self, machine):
        provider,image,folder = self.context(machine)
        if machine.get('leaseCleanup'):
            from .lease_cleanup import cleanup_assignment
            return cleanup_assignment(self,machine,provider,image,folder)
        from .assignment_gate import assignment_access
        with assignment_access(machine,folder):return self._reconcile(machine,provider,image,folder)

    def _reconcile(self,machine,provider,image,folder):
        if machine.get('deletion'):
            request_id=machine['deletion']['id']
            try:
                receipt=provider.remove_owned_storage(machine,image,folder,request_id)
                if receipt.get('state')!='complete' or receipt.get('id')!=request_id or receipt.get('machineId')!=machine['id']:
                    raise Error('The runtime did not return a matching completed deletion receipt.',409)
                return {'state':'stopped','deletion':{'id':request_id,'state':'complete'}}
            except Exception:
                return {'state':'unknown','detail':'Owned removal is blocked; inspect its assignment receipt and retained storage.',
                        'deletion':{'id':request_id,'state':'blocked'}}
        if (folder/'deletion.json').exists():
            raise Error('This assignment has a durable deletion intent and cannot be reconciled or restarted.',409)
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        receipt = folder / "assignment.json"
        fingerprint = digest({"id": machine["id"], "template": machine["template"], "resources": machine["resources"]})
        if receipt.exists():
            if json.loads(receipt.read_text())["fingerprint"] != fingerprint:
                raise Error("Local machine identity belongs to another assignment.")
        else:
            save_json(receipt, {"fingerprint": fingerprint,**({'leaseId':machine['lease']['id']} if machine.get('lease') else {})})
        if machine.get('lease'):
            if not self.lease_guard.allowed(machine['id']):machine={**machine,'desired':'stopped','leaseFenced':True}
            if machine['desired']=='running':
                if provider.config.get('provider')=='apple':
                    from .provisioning import record_preparation
                    record_preparation(machine,folder,self.lease_guard.never_started(machine['id'],machine['lease']['id']))
                self.lease_guard.begin_execution(machine['id'],machine['lease']['id'])
            image={**image,'_leaseAuthorization':lambda:self.lease_guard.authorization(machine['id'],machine['lease']['id'])}
        # Stopping must not generate credentials or wait for guest preparation.
        if machine['desired']=='stopped':
            result=provider.reconcile(machine,image,folder)
            if machine.get('leaseFenced'):result['leaseFenced']=True
            return result
        if image.get('catalogueImageId') and machine['desired']=='running':
            self.library.verify_definition(image)
        if provider.access and image.get("guestAccess"):
            image = provider.access.prepare(machine, image, folder)
        resolved = dict(image)
        prepared = image.get("prepare")
        preparation = None
        if prepared:
            token = credential(folder)
            preparation = {"state": "pending", "tokenHash": digest(token)}
            if machine.get("preparation", {}).get("state") == "ready":
                preparation["state"] = "ready"
            if machine["desired"] == "running":
                if prepared["driver"] != "ssh":
                    endpoint = provider.config.get("guestOrchestratorURL",self.config.get("guestOrchestratorURL"))
                    if not endpoint:
                        raise Error("Set guestOrchestratorURL to an orchestrator address reachable from guests.")
                    resolved["_userData"] = user_data(image, machine, endpoint, token, self.allow_http, notify=not image.get("guestAccess"))
        result = provider.reconcile(machine, resolved, folder)
        if preparation:
            if result["state"] == "running" and provider.access and image.get("guestAccess"):
                result['accessReady']=False
                try:
                    from .guest_access import guest_ready
                    if guest_ready(provider.access.control(machine,image,folder,{"action":"health","arguments":{}}),image):
                        preparation["state"] = "ready"
                        result['accessReady']=True
                except Error:
                    result["detail"] = "Waiting for the verified guest connection." if preparation['state']=='ready' else "Preparing guest services and the verified connection."
            if result["state"] == "running" and machine["desired"] == "running" and prepared["driver"] != "ssh" and preparation["state"] != "ready":
                timing = folder / "preparation-timing.json"
                if not timing.exists():
                    save_json(timing, {"runningAt": time.time()})
                if time.time() - json.loads(timing.read_text())["runningAt"] > prepared.get("timeoutSeconds", 1800):
                    preparation["state"] = "failed"
                    result["detail"] = "Guest preparation receipt timed out; inspect cloud-init/Cloudbase-Init and guest connectivity."
            if result["state"] == "running" and machine["desired"] == "running" and prepared["driver"] == "ssh":
                complete = folder / "ssh-prepared.json"
                if not complete.exists():
                    try:
                        prepare_ssh(image, machine)
                        save_json(complete, {"recipeDigest": machine["template"]["recipeDigest"]})
                    except Exception:
                        result["detail"] = "SSH preparation failed; verify guest access and inspect its preparation marker/logs."
                        preparation["state"] = "failed"
                if complete.exists():
                    preparation["state"] = "ready"
            result["preparation"] = preparation
        return result

    def work(self):
        while not self.stopping.wait(min(1, self.poll_interval)):
            with self.lock:
                assignments = self.lease_guard.assignments(self.assignments)
                connected = contact_fresh(self.last_contact)
            self.sweep_connections({m['id'] for m in assignments if connected and m['desired']=='running'})
            if not connected:
                assignments=[m for m in assignments if m.get('leaseFenced')]
            for machine in assignments:
                if machine.get('leaseCleanup'):continue # Independent cleanup cannot wait behind guest preparation.
                if self.stopping.is_set():
                    return
                with self.lock:
                    if not contact_fresh(self.last_contact) and not machine.get('leaseFenced'):
                        break
                if self.health and self.health['status'] in ('failed','checking') and machine['desired']=='running':
                    continue
                try:
                    report = self.reconcile(machine)
                except Exception as error:
                    # Backend errors can contain local paths, but never credentials.
                    report = {"state": "error", "detail": str(error)[:2000]}
                    with self.lock:
                        previous = self.reports.get(machine["id"], {})
                        if "preparation" in previous:
                            report["preparation"] = {**previous["preparation"], "state": "failed"}
                with self.lock:
                    if machine.get('leaseFenced'):report['leaseFenced']=True
                    if machine.get('powerOffRequest'):report['powerOffId']=machine['powerOffRequest']
                    self.reports[machine["id"]] = report
            self.device_work()

    def device_work(self):
        with self.lock:
            if not contact_fresh(self.last_contact) or self.stopping.is_set():
                return
            operations = list(self.device_operations)
        for operation in operations:
            with self.lock:
                if operation["id"] in self.device_reports or not contact_fresh(self.last_contact):
                    continue
                machine = next((m for m in self.assignments if m["id"] == operation["machineId"]), None)
                running = machine and self.reports.get(machine["id"], {}).get("state") == "running"
            if not machine or not self.lease_guard.allowed(machine['id']):
                report = {"state": "failed", "result": {"detail": "Device assignment is unavailable."}}
            elif operation.get('leaseId') and not self.consumer_operation_authorized(operation):
                report = {"state": "failed", "result": {"detail": "Consumer operation authorization is unavailable."}}
            elif not running and machine["desired"] == "running" and time.time() <= operation["expiresAt"]:
                continue
            else:
                try:
                    runtime,image,folder=self.context(machine)
                    if machine.get('lease'):self.lease_guard.begin_execution(machine['id'],machine['lease']['id'])
                    from .display_access import INPUT_ACTIONS
                    if operation.get('leaseId'):
                        import contextlib
                        from .display_access import InputDenied
                        @contextlib.contextmanager
                        def guard():
                            if not self.consumer_operation_authorized(operation):
                                raise InputDenied('Consumer operation authorization ended before execution.',410,code='lease_ended')
                            if operation['action'] in INPUT_ACTIONS:
                                with self.display_controls.discrete(machine['id'],operation['id'],
                                        lambda:runtime.display_epoch(machine,image,folder),
                                        lambda:self.consumer_operation_authorized(operation)):
                                    yield
                            else:
                                yield
                        report=runtime.operate(machine,image,folder,operation,input_guard=guard)
                    elif operation['action'] in INPUT_ACTIONS:
                        def authorized():
                            with self.lock:
                                current=next((m for m in self.assignments if m['id']==machine['id']),None)
                                connected=not self.stopping.is_set() and contact_fresh(self.last_contact)
                            return connected and current and current['desired']=='running' and self.lease_guard.allowed(machine['id'])
                        guard=lambda:self.display_controls.discrete(machine['id'],operation['id'],
                            lambda:runtime.display_epoch(machine,image,folder),authorized)
                        report=runtime.operate(machine,image,folder,operation,input_guard=guard)
                    else:report = runtime.operate(machine,image,folder,operation)
                except Exception:
                    report = {"state": "unknown", "result": {"detail": "Device operation receipt or assignment requires inspection."}}
            with self.lock:
                self.device_reports[operation["id"]] = report

    def consumer_operation_authorized(self, operation):
        from .lease_eligibility import lease_eligible
        with self.lock:
            if self.stopping.is_set() or not contact_fresh(self.last_contact):return False
            if operation not in self.device_operations or time.time() >= operation['expiresAt']:return False
            machine=next((m for m in self.assignments if m['id']==operation['machineId']),None)
            if not machine or not machine.get('ready') or machine['desired']!='running':return False
            if machine.get('lease',{}).get('id')!=operation['leaseId'] or machine['lease']['state']!='ready':return False
            if not lease_eligible(self.offer,machine.get('template')):return False
        return self.lease_guard.allowed(machine['id'])

    def resource_work(self,interval=5):
        """One observer: stalled I/O never runs in or spawns retries from poll()."""
        from .host_health import sample
        from .infrastructure import validate_sample
        while not self.stopping.is_set():
            try:
                observation=sample(self.config,owned=self.owned_resource_processes)
                if self.stopping.is_set():return
                with self.lock:cluster=self.cluster_report
                observation=copy.deepcopy(observation)
                if cluster is not None:observation['cluster']=copy.deepcopy(cluster)
                validate_sample(observation)
                with self.lock:
                    if self.stopping.is_set():return
                    self.resource_sample=observation
                    self.resource_generation+=1
                    self.last_resource_sample=execution_monotonic()
            except Exception:
                logging.warning('Resource collection failed; retaining the last observation.')
            self.stopping.wait(interval)

    def check_environment(self):
        from .host_health import inspect
        while not self.stopping.is_set():
            self.check_requested.clear()
            if self.stopping.is_set():return
            try:
                report = inspect(self.config,self.provider,self.state_dir)
                if self.stopping.is_set():return
                if hasattr(self.provider,'resource_report'):
                    from .cluster_ownership import assignment_key,unavailable
                    with self.lock:assigned=copy.deepcopy(self.assignments)
                    identity=assignment_key(assigned)
                    cluster=self.provider.resource_report(assignments=assigned)
                    with self.lock:
                        if self.stopping.is_set():return
                        if identity!=assignment_key(self.assignments):
                            cluster=copy.deepcopy(cluster)
                            cluster['canaveral']=unavailable()
                        self.cluster_report=cluster
            except Exception:
                report = {'status':'failed','checkedAt':time.time(),'checks':[{'id':'diagnostics','label':'Environment checks','status':'failed','detail':'Diagnostics failed; inspect the private runner configuration and logs.'}]}
            with self.lock:
                if self.stopping.is_set():return
                self.health = report
            self.check_requested.wait(60)

    def enforce_access_deadlines(self):
        """Revoke host-owned PTYs even while reconciliation is occupied.

        VM execution and in-guest commands still require provider fencing. Do not
        advertise lease execution support on the strength of this watcher alone.
        """
        while not self.stopping.wait(.1):
            try:fenced=self.lease_guard.fenced_machines()
            except Exception:
                logging.error('Lease deadline observation failed; retrying access fencing.')
                continue
            if not fenced:continue
            for runtime in self.runtime_providers():
                try:
                    if hasattr(runtime,'shells'):runtime.shells.revoke(fenced,wait=False)
                except Exception:logging.error('Owned PTY revocation requires retry; lease execution remains fenced.')

    def run(self, enrollment_token=None):
        with HostLock(self.state_dir / "agent.lock"):
            for image in self.config["templates"]:
                if image.get("source"):
                    if self.config["provider"] == "kubevirt":
                        raise Error("KubeVirt uses a base PVC binding; cache/import its base separately and omit source on this offer.")
                    cache = self.config.get("imageCache")
                    if image.get('catalogueImageId'):
                        # The immutable library artifact was verified on import;
                        # do not re-copy or re-hash every disk before heartbeats.
                        continue
                    if self.config['provider'] in ('macos','linux','windows'):
                        from .runtime_config import runtime_for
                        cache=self.provider.runtimes[runtime_for(self.config,image)].config.get('imageCache',cache)
                    if not cache:
                        raise Error("Set imageCache to a backend-readable base image cache directory.")
                    image["image"] = prepare_image(image["source"], cache)
            self.health = {'status':'checking','checkedAt':time.time(),'checks':[]}
            if self.inference_runner:
                self.inference_runner.check()
            try:self.connect(enrollment_token)
            except Error:
                if not self.lease_guard.records or not hasattr(self,'client'):raise
                logging.warning('Host enrollment unavailable; enforcing persisted lease deadlines while reconnecting.')
            workers={};primary_failure=False
            self.resource_worker=None
            def start_worker(name,target):
                thread=threading.Thread(target=target,daemon=True)
                # Track before start: cancellation can arrive after the native
                # thread exists but before Thread.start() returns.
                workers[name]=thread
                if name=='resources':self.resource_worker=thread
                thread.start()
            def join_worker(name,timeout):
                thread=workers.get(name)
                if thread is not None and thread.ident is not None:thread.join(timeout=timeout)
            try:
                start_worker('health',self.check_environment)
                start_worker('resources',self.resource_work)
                start_worker('deadlines',self.enforce_access_deadlines)
                start_worker('reconcile',self.work)
                start_worker('images',self.image_work)
                start_worker('access',self.access_runner.work)
                start_worker('native',self.native_lease_updates.work)
                start_worker('cleanup',self.cleanup_runner.work)
                if self.inference_runner:start_worker('inference',self.inference_work)
                while not self.stopping.is_set():
                    try:
                        self.poll()
                    except Error as error:
                        logging.warning("Host heartbeat: %s", error)
                    if not contact_fresh(self.last_contact):self.sweep_connections(set())
                    self.stopping.wait(self.poll_interval)
            except BaseException:
                primary_failure=True
                raise
            finally:
                self.stopping.set()
                self.check_requested.set()
                failures=[]
                def cleanup(name,operation,*args):
                    try:operation(*args)
                    except Exception:
                        failures.append(name)
                        logging.warning('Host %s cleanup was not confirmed.',name)
                cleanup('access worker',join_worker,'access',5)
                cleanup('access sessions',self.access_runner.close)
                cleanup('native worker',join_worker,'native',2)
                cleanup('native supervisors',self.native_lease_updates.close)
                cleanup('cleanup worker',join_worker,'cleanup',2)
                cleanup('cleanup supervisors',self.cleanup_runner.close)
                cleanup('display ownership',self.display_controls.close)
                cleanup('connections',self.sweep_connections,set())
                cleanup('deadline worker',join_worker,'deadlines',5)
                cleanup('reconcile worker',join_worker,'reconcile',310)
                cleanup('image worker',join_worker,'images',310)
                cleanup('connections',self.sweep_connections,set())
                cleanup('inference worker',join_worker,'inference',150)
                cleanup('resource observer',join_worker,'resources',1)
                cleanup('environment observer',join_worker,'health',1)
                if failures and not primary_failure:
                    raise Error('Host shutdown was not fully confirmed; inspect owned session and worker state.',409,
                                code='host_shutdown_incomplete',retryable=False,outcome='unknown')
