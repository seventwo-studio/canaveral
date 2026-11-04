"""Loopback-only helper inside an owned Linux guest; never runs on the host."""
import base64
import io
import hmac
import json
import os
import secrets
import subprocess
import sys
import threading
import time
import uuid
import tempfile
import struct
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote
from canaveral.transfers import atomic_upload,file_identity

from canaveral.shell_sessions import ShellSessions
from canaveral.model import Error
from canaveral.accessibility import Inspections

TOKEN=Path(sys.argv[1]).read_text().strip() if __name__=='__main__' else ''
MODE=os.environ.get('CANAVERAL_GUEST_MODE','desktop')
if MODE not in ('headless','desktop'):raise RuntimeError('Invalid guest service mode.')
SHELLS=ShellSessions()
INSPECTIONS=Inspections()
LOCK=threading.RLock()


def control(action,args):
    if MODE=='headless' and action in ('screenshot','hierarchy','accessibility','accessibility-action','tap','swipe','text','key'):
        raise Error('This headless guest has no graphical control or accessibility service.',409,code='capability_unsupported')
    if action=='screenshot':
        with tempfile.TemporaryDirectory(prefix='canaveral-screen-') as folder:
            path=Path(folder)/'frame.png'
            subprocess.run(['scrot','-o',str(path)],check=True,timeout=5,capture_output=True)
            data=path.read_bytes()
        if len(data)>4*1048576:raise Error('Desktop frame exceeds 4 MiB.')
        width,height=struct.unpack('>II',data[16:24])
        return dict(id=str(uuid.uuid4()),capturedAt=time.time(),width=width,height=height,data=base64.b64encode(data).decode(),mediaType='image/png')
    if action=='health':return {'ready':Path('/opt/canaveral/prepared').exists(),'durableWrites':True,'mode':MODE}
    if action=='shell-open': return SHELLS.open('guest',args['session'],['/bin/bash','-il'])
    if action.startswith('shell-'): return SHELLS.control('guest',action,args)
    if action=='list-files':
        path=Path(args['path']).expanduser()
        entries=[]
        for entry in sorted(path.iterdir(),key=lambda p:(not p.is_dir(),p.name.casefold()))[:2001]:
            try:
                st=entry.stat()
                entries.append(dict(name=entry.name,kind='directory' if entry.is_dir() else 'file',size=st.st_size,modifiedAt=st.st_mtime))
            except OSError: entries.append(dict(name=entry.name,kind='file',unavailable=True))
        return dict(path=str(path),entries=entries[:2000],truncated=len(entries)>2000)
    if action=='pull':
        with Path(args['path']).open('rb') as f:data=f.read(4*1048576+1)
        if len(data)>4*1048576:raise Error('Download exceeds 4 MiB.')
        return dict(data=base64.b64encode(data).decode(),mediaType='application/octet-stream')
    if action=='push':
        data=base64.b64decode(args['data'],validate=True)
        if len(data)>524288:raise Error('Upload exceeds 512 KiB.')
        target=Path(args['path'])
        if not target.is_absolute():raise Error('Use an absolute guest file path.')
        parent=os.open(str(target.parent),os.O_RDONLY|os.O_DIRECTORY)
        try:atomic_upload(parent,target.name,io.BytesIO(data),len(data))
        finally:os.close(parent)
        return dict(written=len(data),durable=True)
    if action=='accessibility':
        started=INSPECTIONS.clock()
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('inspect_linux.py'))],capture_output=True,timeout=5,check=True)
        if len(result.stdout)>4*1048576:raise Error('Accessibility tree exceeds the response limit.')
        inspection={**json.loads(result.stdout), 'snapshotId':str(uuid.uuid4()),'capturedAt':time.time(),'source':'linux-atspi','coordinateSpace':'screen-pixels','coverage':'Native AT-SPI data. Custom-rendered controls may be absent; an empty tree does not imply an empty desktop.'}
        INSPECTIONS.save('guest',inspection,started=started)
        if args.get('includeFrame',True):
            return {**inspection,'frame':control('screenshot',{})}
        return inspection
    if action=='accessibility-action':
        INSPECTION,lifetime=INSPECTIONS.action_context('guest',args['snapshotId'])
        node=next((n for n in INSPECTION['nodes'] if n['id']==args['nodeId']),None)
        if not node:raise Error('Unknown accessibility node.',409,code='input_rejected')
        if args['nativeAction'] not in node['actions']:raise Error('Action not exposed by this node.',409,code='input_rejected')
        try:
            chain=list(reversed(INSPECTIONS.lineage(INSPECTION,args['nodeId'])))
            payload=json.dumps({'chain':chain,'action':args['nativeAction'],**lifetime},allow_nan=False).encode()
            if len(payload)>6*1048576:raise ValueError('Action context exceeds its envelope')
        except (Error,ValueError,KeyError,TypeError):
            raise Error('Accessibility action context is unavailable. Inspect again.',409,code='input_rejected')
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('action_linux.py'))],input=payload,timeout=5,capture_output=True)
        if result.returncode==42:raise Error('Accessibility target changed or is unavailable. Inspect again.',409,code='input_rejected')
        if result.returncode:raise Error('Accessibility action outcome was not confirmed.')
        INSPECTIONS.discard('guest',args['snapshotId'])
        return dict(posted=True)
    raise Error('Unsupported Linux guest action.',409,code='input_rejected')


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_HEAD(self):
        if self.path!='/file' or not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN):
            self.send_response(401);self.send_header('Content-Length','0');self.end_headers();return
        descriptor=None
        try:
            target=Path(unquote(self.headers.get('X-Canaveral-Path','')))
            if not target.is_absolute():raise Error('Use an absolute guest file path.')
            descriptor=os.open(str(target),os.O_RDONLY|os.O_NONBLOCK)
            metadata=os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):raise Error('Downloads require a regular file.')
            self.send_response(200);self.send_header('Content-Length',str(metadata.st_size))
            self.send_header('X-Canaveral-File-Identity',file_identity(metadata));self.end_headers()
        except Exception:
            self.send_response(409);self.send_header('Content-Length','0');self.end_headers()
        finally:
            if descriptor is not None:os.close(descriptor)
    def do_GET(self):
        if self.path=='/file':
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN):
                self.reply({'error':'Credential rejected'},401);return
            started=False
            try:
                target=Path(unquote(self.headers.get('X-Canaveral-Path','')))
                if not target.is_absolute():raise Error('Use an absolute guest file path.')
                fd=os.open(str(target),os.O_RDONLY|os.O_NONBLOCK)
                with os.fdopen(fd,'rb') as source:
                    metadata=os.fstat(source.fileno())
                    if not stat.S_ISREG(metadata.st_mode):raise Error('Downloads require a regular file.')
                    started=True
                    self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(metadata.st_size));self.send_header('X-Canaveral-File-Identity',file_identity(metadata));self.end_headers()
                    remaining=metadata.st_size
                    while remaining:
                        data=source.read(min(1048576,remaining))
                        if not data:break
                        self.wfile.write(data);remaining-=len(data)
            except Exception as error:
                if not started and not self.wfile.closed:
                    try:self.reply({'error':str(error)[:300]},409)
                    except OSError:pass
            return
        if self.path=='/healthz': self.reply({'ok':True});return
        self.reply({'error':'Unknown endpoint'},404)
    def do_PUT(self):
        if self.path!='/file' or not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN):
            self.reply({'error':'Credential rejected'},401);return
        try:
            size=int(self.headers.get('Content-Length','-1'))
            if size<0 or self.headers.get('Transfer-Encoding'):raise Error('A content length is required.')
            target=Path(unquote(self.headers.get('X-Canaveral-Path','')))
            if not target.is_absolute():raise Error('Use an absolute guest file path.')
            parent=os.open(str(target.parent),os.O_RDONLY|os.O_DIRECTORY)
            try:result=atomic_upload(parent,target.name,self.rfile,size)
            finally:os.close(parent)
            self.reply(result)
        except Exception as error:
            self.reply({'error':str(error)[:300]},409)
    def do_POST(self):
        if self.path!='/control' or not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN):
            self.reply({'error':'Credential rejected'},401);return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=1048576:raise Error('Invalid request size.')
            value=json.loads(self.rfile.read(length))
            if value['action'].startswith('shell-'):
                # PTY sessions have their own lock; a slow UI inspection must
                # not hold terminal input/output behind the global action lock.
                result=control(value['action'],value['arguments'])
            else:
                with LOCK: result=control(value['action'],value['arguments'])
            self.reply(result)
        except Exception as error:
            self.reply({'error':str(error)[:300],'code':error.code if isinstance(error,Error) else 'operation_incomplete'},409)
    def reply(self,value,status=200):
        body=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)


if __name__=='__main__':
    def sweep():
        while True:time.sleep(5);SHELLS.sweep()
    threading.Thread(target=sweep,daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1',8769),Handler).serve_forever()
