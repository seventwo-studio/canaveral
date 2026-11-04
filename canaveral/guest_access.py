"""Owned Linux guest access. Connection destinations are derived from host bindings."""
import copy
import ipaddress
import json
import re
import secrets
import shlex
import socket
import subprocess
import threading
import time
import urllib.request
import urllib.parse
import http.client
from types import SimpleNamespace
from pathlib import Path

from .files import save_json
from .assignment_process import assignment_popen,assignment_run
from .model import Error, identifier


def helper_files():
    root=Path(__file__).parent
    files=[]
    for source,destination in [('__init__.py','canaveral/__init__.py'),('model.py','canaveral/model.py'),('lease_clock.py','canaveral/lease_clock.py'),('accessibility.py','canaveral/accessibility.py'),('shell_sessions.py','canaveral/shell_sessions.py'),('transfers.py','canaveral/transfers.py'),('guest/server.py','server.py'),('guest/inspect_linux.py','inspect_linux.py'),('guest/action_linux.py','action_linux.py')]:
        files.append(dict(path='/opt/canaveral/'+destination,content=(root/source).read_text(),mode='0644'))
    return files


def desktop_recipe(public_key):
    files=helper_files()
    files += [dict(path='/etc/sudoers.d/canaveral-desktop',content='desktop ALL=(ALL) NOPASSWD:ALL\n',mode='0440'),dict(path='/opt/canaveral/canaveral/__init__.py',content='',mode='0644'),
              dict(path='/opt/canaveral/start-desktop',mode='0755',content='''#!/bin/sh
set -eu
export DISPLAY=:1
export NO_AT_BRIDGE=0
export GTK_MODULES=gail:atk-bridge
export XDG_RUNTIME_DIR=/tmp/canaveral-runtime
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
/usr/bin/Xtigervnc :1 -geometry 1440x900 -depth 24 -SecurityTypes None -localhost yes &
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
for attempt in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep .2; done
gsettings set org.gnome.desktop.interface toolkit-accessibility true || true
xfce4-session &
exec /usr/bin/python3 /opt/canaveral/server.py /opt/canaveral/token
'''),
              dict(path='/etc/systemd/system/canaveral-desktop.service',mode='0644',content='''[Unit]
Description=Canaveral owned guest desktop
After=network.target
[Service]
User=desktop
Group=desktop
WorkingDirectory=/home/desktop
Environment=CANAVERAL_GUEST_MODE=desktop
ExecStart=/usr/bin/dbus-run-session -- /opt/canaveral/start-desktop
Restart=on-failure
[Install]
WantedBy=multi-user.target
''')]
    return dict(driver='cloud-init',user='desktop',sshAuthorizedKeys=[public_key],packages=['xfce4','xfce4-terminal','tigervnc-standalone-server','dbus-x11','at-spi2-core','python3-pyatspi','python3','curl','x11-utils','scrot'],files=files,commands=[
        'chown -R desktop:desktop /opt/canaveral /home/desktop',
        'if systemctl cat canaveral-headless.service >/dev/null 2>&1; then systemctl disable --now canaveral-headless.service; fi',
        'systemctl daemon-reload','systemctl restart ssh','systemctl enable --now canaveral-desktop',
        'for attempt in $(seq 1 120); do curl --fail --silent http://127.0.0.1:8769/healthz && exit 0; sleep 2; done; exit 1', 'touch /opt/canaveral/prepared'
    ],timeoutSeconds=3600)


def guest_recipe(public_key,mode):
    if mode=='desktop':return desktop_recipe(public_key)
    if mode!='headless':raise Error('Linux guest services require headless or desktop mode.',400)
    files=helper_files()
    files.append(dict(path='/etc/systemd/system/canaveral-headless.service',mode='0644',content='''[Unit]
Description=Canaveral owned headless guest services
After=network.target
[Service]
User=desktop
Group=desktop
WorkingDirectory=/home/desktop
Environment=CANAVERAL_GUEST_MODE=headless
ExecStart=/usr/bin/python3 /opt/canaveral/server.py /opt/canaveral/token
Restart=on-failure
[Install]
WantedBy=multi-user.target
'''))
    # Preserve the established guest account and SSH/file paths without
    # installing a graphical session or native accessibility dependencies.
    return dict(driver='cloud-init',user='desktop',sshAuthorizedKeys=[public_key],
        packages=['python3','curl','openssh-server'],files=files,commands=[
            'chown -R desktop:desktop /opt/canaveral /home/desktop',
            'if systemctl cat canaveral-desktop.service >/dev/null 2>&1; then systemctl disable --now canaveral-desktop.service; fi',
            'systemctl daemon-reload','systemctl restart ssh',
            'systemctl enable canaveral-headless && systemctl restart canaveral-headless',
            'for attempt in $(seq 1 120); do curl --fail --silent http://127.0.0.1:8769/healthz && exit 0; sleep 2; done; exit 1',
            'touch /opt/canaveral/prepared'],timeoutSeconds=1800)


def guest_ready(value,image):
    if not isinstance(value,dict) or value.get('ready') is not True:return False
    mode=value.get('mode')
    # Existing desktop helpers remain compatible. A headless image needs an
    # explicit matching profile, never an old graphical service's ready flag.
    return mode==image.get('mode') if mode is not None else image.get('mode')=='desktop'


class GuestAccess:
    def __init__(self, config, state):
        self.config=config
        self.state=Path(state)
        self.forwards={}
        self.lock=threading.RLock()
        self.connection_failures={}
        self.retry_at={}

    def connection_failed(self,key):
        with self.lock:
            failures=min(6,self.connection_failures.get(key,0)+1)
            self.connection_failures[key]=failures
            self.retry_at[key]=time.monotonic()+min(60,2**failures)
            previous=self.forwards.pop(key,None)
            if previous and previous[0].poll() is None:
                try:previous[0].terminate()
                except ProcessLookupError:return
                try:previous[0].wait(timeout=.5)
                except subprocess.TimeoutExpired:previous[0].kill();previous[0].wait(timeout=1)

    def connection_succeeded(self,key):
        with self.lock:
            self.connection_failures.pop(key,None);self.retry_at.pop(key,None)

    def prepare(self,machine,image,folder):
        settings=self.config['guestAccess']
        folder=Path(folder)
        token=folder/'access-token.json'
        if not token.exists():save_json(token,{'token':secrets.token_urlsafe(32)})
        host_key=folder/'ssh_host_ed25519_key'
        if not host_key.exists():
            assignment_run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(host_key)],check=True,stdout=subprocess.DEVNULL)
        result=copy.deepcopy(image)
        # Management helpers are refreshed for the new instance; application
        # files and the source image/recipe remain unchanged.
        helpers=helper_files();managed={item['path'] for item in helpers}
        result['prepare']['files']=[item for item in result['prepare']['files'] if item['path'] not in managed]+helpers
        result['prepare']['files'] += [
            dict(path='/opt/canaveral/token',content=json.loads(token.read_text())['token'],mode='0600'),
            dict(path='/etc/ssh/ssh_host_ed25519_key',content=host_key.read_text(),mode='0600'),
            dict(path='/etc/ssh/ssh_host_ed25519_key.pub',content=Path(str(host_key)+'.pub').read_text(),mode='0644')]
        # Pin SSH to the key installed into this assignment's seed, never trust a scan.
        result['prepare']['commands'].insert(0,'chown desktop:desktop /opt/canaveral/token')
        result['prepare']['commands']=[command for command in result['prepare']['commands'] if command!='touch /opt/canaveral/prepared']
        complete='/var/lib/canaveral/'+identifier(machine['id'])+'/complete'
        result['prepare']['commands'].append('sync; touch '+shlex.quote(complete)+'; sync; touch /opt/canaveral/prepared; sync')
        return result

    def host(self,machine,image):
        configured=image.get('ssh',{}).get('host')
        if configured:
            host=configured.replace('{id}',machine['id'])
            try:ipaddress.ip_address(host)
            except ValueError:raise Error('Guest access requires a configured literal address.')
            return host
        if self.config.get('provider')!='apple':raise Error('Configure a guest address for this backend.')
        mac='02:'+':'.join(machine['id'].replace('-','')[i:i+2] for i in range(0,10,2))
        def normalize(value):return ':'.join(part.zfill(2) for part in value.lower().split(':')[-6:])
        for block in Path('/var/db/dhcpd_leases').read_text().split('}'):
            hardware=re.search(r'hw_address=1,([^\s]+)',block)
            address=re.search(r'ip_address=([^\s]+)',block)
            hostname=re.search(r'name=([^\s]+)',block)
            if address and ((hardware and normalize(hardware.group(1))==mac) or (hostname and hostname.group(1)=='cvm-'+machine['id'])):
                ip=ipaddress.ip_address(address.group(1))
                if not ip.is_private:raise Error('Owned guest address is not private.')
                return str(ip)
        raise Error('Waiting for the owned guest DHCP address.')

    def tunnel(self,machine,image,folder,remote_port):
        key=(machine['id'],remote_port)
        with self.lock:
            if time.monotonic()<self.retry_at.get(key,0):raise Error('Guest connection retry is backing off; waiting for the SSH service.',503)
            previous=self.forwards.get(key)
            if previous and previous[0].poll() is None:return previous[1]
            host=self.host(machine,image)
            folder=Path(folder)
            pub=Path(str(folder/'ssh_host_ed25519_key')+'.pub').read_text().strip().split()
            known=folder/'known_hosts'
            known.write_text(host+' '+pub[0]+' '+pub[1]+'\n');known.chmod(0o600)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            identity=self.config['guestAccess']['identityFile']
            command=['ssh','-N','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=\"'+str(known).replace('\\','\\\\').replace('\"','\\\"')+'\"',
                     '-o','GlobalKnownHostsFile=/dev/null','-o','IdentitiesOnly=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=5',
                     '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-i',identity,
                     '-L','127.0.0.1:'+str(port)+':127.0.0.1:'+str(remote_port),'desktop@'+host]
            log=(folder/'access.log').open('ab')
            try:process=assignment_popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
            finally:log.close()
            self.forwards[key]=(process,port)
            until=time.monotonic()+7
            while time.monotonic()<until:
                if process.poll() is not None:
                    self.connection_failed(key)
                    raise Error('Guest SSH connection failed; inspect private access.log.')
                try:
                    with socket.create_connection(('127.0.0.1',port),timeout=.2):return port
                except OSError:time.sleep(.1)
            self.connection_failed(key);raise Error('Guest SSH connection timed out.')

    def control(self,machine,image,folder,request):
        if image.get('mode')=='headless' and request.get('action') in ('screenshot','hierarchy','accessibility','accessibility-action','tap','swipe','text','key'):
            from .display_access import InputDenied
            raise InputDenied('This headless guest has no graphical control or accessibility service.',409,code='capability_unsupported')
        port=self.tunnel(machine,image,folder,8769)
        token=json.loads((Path(folder)/'access-token.json').read_text())['token']
        body=json.dumps(request).encode()
        req=urllib.request.Request('http://127.0.0.1:'+str(port)+'/control',data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req,timeout=12) as response:result=json.loads(response.read(6*1048576))
            self.connection_succeeded((machine['id'],8769))
            return result
        except Exception as error:
            if hasattr(error,'read'):
                try:
                    result=json.loads(error.read(4096))
                    if result.get('code')=='input_rejected':
                        from .display_access import InputDenied
                        raise InputDenied(result.get('error','Guest input was refused before dispatch.'),409,code='input_rejected')
                    raise Error(result.get('error','Guest operation failed.'))
                except (ValueError,AttributeError):pass
            self.connection_failed((machine['id'],8769))
            raise Error('Guest access unavailable; inspect its preparation and connection.')

    def shutdown(self,machine,image,folder,boot):
        """Request graceful shutdown once per native boot, including lost responses."""
        import uuid
        with self.lock:
            receipt=Path(folder)/'guest-shutdown.json'
            if receipt.exists() and json.loads(receipt.read_text()).get('boot')==boot:return
            session=str(uuid.uuid4())
            self.control(machine,image,folder,{'action':'shell-open','arguments':{'session':session}})
            # Persist before dispatch: a disconnected response must not replay the command.
            save_json(receipt,{'boot':boot,'session':session,'requestedAt':time.time()})
            self.control(machine,image,folder,{'action':'shell-write','arguments':{'session':session,'text':'sudo -n systemctl poweroff\n'}})

    def stream_upload(self,machine,image,folder,path,app,reader,size,authorized):
        from .transfers import copy_upload
        if not authorized():raise Error('Upload authorization ended before opening the guest connection.',401)
        port=self.tunnel(machine,image,folder,8769)
        token=json.loads((Path(folder)/'access-token.json').read_text())['token']
        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=25)
        try:
            connection.putrequest('PUT','/file')
            connection.putheader('Authorization','Bearer '+token)
            connection.putheader('X-Canaveral-Path',urllib.parse.quote(path,safe=''))
            connection.putheader('Content-Length',str(size))
            if not authorized():raise Error('Upload authorization ended before dispatch.',401)
            connection.endheaders()
            copy_upload(reader,SimpleNamespace(write=connection.send),size,authorized)
            response=connection.getresponse()
            result=json.loads(response.read(8192))
            if response.status!=200:raise Error(result.get('error','Guest upload failed.'),response.status)
            if not authorized():raise Error('Upload authorization ended before acknowledgement; guest publication may have occurred.',401)
            return result
        finally:connection.close()

    def stream_download(self,machine,image,folder,path,app):
        from .transfers import Download
        port=self.tunnel(machine,image,folder,8769)
        token=json.loads((Path(folder)/'access-token.json').read_text())['token']
        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=25)
        try:
            connection.request('GET','/file',headers={'Authorization':'Bearer '+token,'X-Canaveral-Path':urllib.parse.quote(path,safe='')})
            response=connection.getresponse()
            if response.status!=200:
                raise Error(json.loads(response.read(4096)).get('error','Guest download failed.'),response.status)
            identity=response.getheader('X-Canaveral-File-Identity')
            def verify():
                if not identity:raise Error('This guest helper cannot verify download identity; update it before broker transfer.',409)
                check=http.client.HTTPConnection('127.0.0.1',port,timeout=12)
                try:
                    check.request('HEAD','/file',headers={'Authorization':'Bearer '+token,'X-Canaveral-Path':urllib.parse.quote(path,safe='')})
                    current=check.getresponse()
                    return current.status==200 and current.getheader('X-Canaveral-File-Identity')==identity
                finally:check.close()
            return Download(response,int(response.getheader('Content-Length')),connection.close,verify)
        except Exception:
            connection.close();raise

    def desktop(self,machine,image,folder):
        if image.get('mode')=='headless':raise Error('This headless guest has no graphical display.',409,code='capability_unsupported')
        host=self.host(machine,image)
        folder=Path(folder)
        pub=Path(str(folder/'ssh_host_ed25519_key')+'.pub').read_text().strip().split()
        known=folder/'known_hosts'
        known.write_text(host+' '+pub[0]+' '+pub[1]+'\n');known.chmod(0o600)
        # Carry VNC over private SSH stdio: no unauthenticated host TCP listener.
        program="""import os,select,socket
s=socket.create_connection(('127.0.0.1',5901),10)
while True:
 ready,_,_=select.select([0,s],[],[],30)
 if 0 in ready:
  data=os.read(0,65536)
  if not data:break
  s.sendall(data)
 if s in ready:
  data=s.recv(65536)
  if not data:break
  view=memoryview(data)
  while view:view=view[os.write(1,view):]
"""
        argv=['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile="'+str(known)+'"',
              '-o','GlobalKnownHostsFile=/dev/null','-o','IdentitiesOnly=yes','-o','ConnectTimeout=5',
              '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-i',self.config['guestAccess']['identityFile'],
              'desktop@'+host,'python3 -u -c '+shlex.quote(program)]
        local,remote=socket.socketpair()
        log=(folder/'access.log').open('ab')
        try:
            process=assignment_popen(argv,stdin=remote,stdout=remote,stderr=log,start_new_session=True)
        except Exception:
            local.close()
            raise
        finally:
            remote.close();log.close()
        return ProcessSocket(local,process)

    def sweep(self,active):
        with self.lock:
            for key,(process,port) in list(self.forwards.items()):
                if key[0] not in active:
                    process.terminate()
                    try:process.wait(timeout=2)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
                    del self.forwards[key]

    def close_machine(self,machine_id):
        with self.lock:
            for key,(process,port) in list(self.forwards.items()):
                if key[0]!=machine_id:continue
                if process.poll() is None:
                    process.terminate()
                    try:process.wait(timeout=2)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
                if process.poll() is None:raise Error('Owned guest connection has not closed.',409)
                self.forwards.pop(key,None)


class ProcessSocket:
    def __init__(self,sock,process):
        self.socket,self.process=sock,process
    def fileno(self):return self.socket.fileno()
    def recv(self,*args):return self.socket.recv(*args)
    def sendall(self,*args):return self.socket.sendall(*args)
    def settimeout(self,*args):return self.socket.settimeout(*args)
    def close(self):
        self.socket.close()
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=2)
