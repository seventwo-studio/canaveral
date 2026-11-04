"""TLS uses private loopback listeners and ephemeral trust, never live services."""
import io
import base64
import os
import shutil
import ssl
import subprocess
import tempfile
import unittest
import uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from canaveral.api import server as api_server
from canaveral.client import Client
from canaveral.files import save_json
from canaveral.model import Error
from canaveral.sdk import ConsumerClient,LeaseClient
from canaveral.session_transport import SessionConnection
from test_access_sessions import AccessFixture
from test_runner_sessions import RunnerFixture

try:
    from PIL import Image
except ImportError:Image=None


class TLSFixture:
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        binary=shutil.which('openssl')
        if not binary:raise unittest.SkipTest('OpenSSL is required for disposable TLS certificates.')
        cls.certificates=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.certificates.cleanup)
        root=Path(cls.certificates.name)
        config=root/'openssl.conf'
        config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n'
            '[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n'
            'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
        for name in ('trusted','untrusted'):
            subprocess.run([binary,'req','-new','-x509','-newkey','rsa:2048','-nodes','-days','1',
                '-config',str(config),'-keyout',str(root/(name+'.key')),'-out',str(root/(name+'.crt'))],
                check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        cls.certificate=root/'trusted.crt';cls.private_key=root/'trusted.key';cls.untrusted=root/'untrusted.crt'

    def encrypt(self,service):
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.certificate),str(self.private_key))
        service.socket=context.wrap_socket(service.socket,server_side=True)
        return service

    def setUp(self):
        super().setUp()
        service=self.encrypt(api_server(self.store,('127.0.0.1',0),self.admin,self.enrollment))
        self.start(service);self.tls_url='https://localhost:'+str(service.server_port)
        environment=patch.dict(os.environ,{'NO_PROXY':'localhost,127.0.0.1','no_proxy':'localhost,127.0.0.1'})
        environment.start();self.addCleanup(environment.stop)


class SessionTLSRejectionTests(TLSFixture,AccessFixture):
    def rejected_before_attachment(self,url,certificate):
        self.ready();session=self.create()
        with patch.object(self.store,'get_lease',wraps=self.store.get_lease) as inspected, \
             patch.object(self.store,'attach_access_session',wraps=self.store.attach_access_session) as attached:
            client=Client(url,self.token,ca_file=str(certificate))
            self.assertTrue(client.ssl_context.check_hostname);self.assertEqual(client.ssl_context.verify_mode,ssl.CERT_REQUIRED)
            with self.assertRaises(Error):client.request('GET','/v1/leases/'+self.lease['id'])
            with self.assertRaises(Error):SessionConnection(client,self.path+'/'+session['id']+'/'+session['generation'])
            inspected.assert_not_called();attached.assert_not_called()
        self.assertEqual(self.store.get_access_session(self.lease['id'],session['id'],self.token)['state'],'pending')

    def test_untrusted_certificate_rejects_http_and_websocket_before_credentials_are_admitted(self):
        self.rejected_before_attachment(self.tls_url,self.untrusted)

    def test_trusted_certificate_wrong_hostname_rejects_http_and_websocket(self):
        self.rejected_before_attachment(self.tls_url.replace('localhost','127.0.0.1'),self.certificate)

    def test_bad_ca_configuration_is_refused_before_credential_rotation(self):
        application=ConsumerClient(self.tls_url,self.a['credential'],ca_file=str(self.certificate))
        application.client.ca_file=str(Path(self.temp.name)/'missing.crt')
        with patch.object(self.store,'lease_credential',wraps=self.store.lease_credential) as rotation:
            with self.assertRaises(Error) as error:application.scoped_lease(self.lease['id'])
            self.assertEqual(error.exception.status,400);rotation.assert_not_called()
        with self.assertRaises(Error):Client(self.upstream,self.token,ca_file=str(self.certificate))

    def test_sdk_file_factories_preserve_explicit_ca_without_rotating_keys(self):
        app=Path(self.temp.name)/'application.key';app.write_text(self.a['credential']);app.chmod(0o600)
        key=Path(self.temp.name)/'lease.key';key.write_text(self.token);key.chmod(0o600)
        application=ConsumerClient.from_credential_file(self.tls_url,app,ca_file=self.certificate)
        lease=LeaseClient.from_credential_file(self.tls_url,self.lease['id'],key,ca_file=self.certificate)
        self.assertEqual(application.inspect(self.lease['id'])['id'],self.lease['id'])
        self.assertEqual(lease.inspect()['id'],self.lease['id'])

    def test_https_redirect_never_follows_or_forwards_credentials_to_destination(self):
        destinations=[]
        class Destination(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                destinations.append(self.path);self.send_response(200);self.end_headers();self.wfile.write(b'{}')
        target=ThreadingHTTPServer(('127.0.0.1',0),Destination);self.start(target)
        class Redirect(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.send_response(302);self.send_header('Location','http://127.0.0.1:'+str(target.server_port)+'/destination')
                self.send_header('Content-Length','0');self.end_headers()
        redirect=self.encrypt(ThreadingHTTPServer(('127.0.0.1',0),Redirect));self.start(redirect)
        url='https://localhost:'+str(redirect.server_port)
        with self.assertRaises(Error):Client(url,self.token,ca_file=str(self.certificate)).request('GET','/redirect')
        with self.assertRaises(Error):SessionConnection(Client(url,self.token,ca_file=str(self.certificate)),'/v1/redirect')
        self.assertEqual(destinations,[])


class RunnerTLSTests(TLSFixture,RunnerFixture):
    def finish_runner(self):
        if getattr(self,'tls_runner_finished',False):return
        self.tls_runner_finished=True;super().finish_runner()

    def setUp(self):
        super().setUp()
        self.agent.url=self.tls_url;self.agent.ca_file=str(self.certificate)
        save_json(self.agent.state_dir/'identity.json',{'id':self.host,'credential':self.host_token,'orchestrator':self.tls_url})
        self.agent.connect(None)
        self.sdk=LeaseClient(self.tls_url,self.lease['id'],self.token,ca_file=str(self.certificate))
        # Stop all fixture clients before tearing down TLS or its scoped trust.
        self.addCleanup(self.finish_runner)
        self.transports=[];original=SessionConnection.__init__
        owner=self
        def encrypted(connection,client,path,*args,**kwargs):
            owner.assertTrue(client.url.startswith('https://'))
            original(connection,client,path,*args,**kwargs)
            owner.assertIsInstance(connection.socket,ssl.SSLSocket)
            owner.assertIsNotNone(connection.socket.cipher())
            owner.transports.append(path)
        patcher=patch.object(SessionConnection,'__init__',encrypted);patcher.start();self.addCleanup(patcher.stop)

    def test_tls_lifecycle_pty_files_and_accessibility_through_real_runner(self):
        application=ConsumerClient(self.tls_url,self.a['credential'],ca_file=str(self.certificate))
        self.assertTrue(application.catalogue()['templates']);self.assertEqual(application.inspect(self.lease['id'])['id'],self.lease['id'])
        self.sdk=application.scoped_lease(self.lease['id'])
        self.assertEqual(self.sdk.client.ca_file,str(self.certificate))
        session,terminal=self.terminal()
        with terminal:
            terminal.send_control({'action':'shell-write','arguments':{'text':'printf TLS_FIXTURE_PROOF\\n\n'}})
            self.output_until(terminal,b'TLS_FIXTURE_PROOF')
            terminal.send_control({'action':'shell-resize','arguments':{'rows':40,'cols':120}})
        data=b'TLS fixture\x00\r\n'*10000
        upload=str(uuid.uuid4());self.sdk.upload(upload,'primary','file',io.BytesIO(data),len(data))
        target=Path(self.temp.name)/'download';self.sdk.download_to_file(str(uuid.uuid4()),'primary','file',target)
        self.assertEqual(target.read_bytes(),data)
        previous=self.backend.control
        def control(machine,image,folder,request):
            if request['action']=='hierarchy':return '<hierarchy><node class="Button" text="TLS" bounds="[0,0][2,2]"/></hierarchy>'
            return previous(machine,image,folder,request)
        self.backend.control=control
        snapshot=self.sdk.accessibility(str(uuid.uuid4()));self.assertEqual(snapshot['nodes'][0]['name'],'TLS')
        self.assertEqual(len(self.transports),8)
        self.assertEqual(sum(path.startswith('/v1/hosts/') for path in self.transports),4)
        self.assertEqual(sum(path.startswith('/v1/leases/') for path in self.transports),4)

    @unittest.skipUnless(Image,'Install the visual extra for TLS display capture.')
    def test_tls_display_capture_owned_input_and_receipt(self):
        from canaveral.providers.mobile import Mobile
        from canaveral.simulator_screen import connect
        provider=Mobile({},self.folder);image=io.BytesIO();Image.new('RGB',(2,2),(10,20,30)).save(image,format='PNG')
        provider.control=lambda machine,definition,folder,request:{'data':base64.b64encode(image.getvalue()).decode()} if request['action']=='screenshot' else {'posted':True}
        self.backend.operate=lambda machine,image,folder,operation:Mobile.operate(provider,machine,{},folder,operation)
        self.backend.desktop=lambda machine,image,folder:connect(provider,machine,{'os':'android'},folder,lambda:True)
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as display:
            screenshot=display.screenshot()
            with Image.open(io.BytesIO(screenshot)) as captured:self.assertGreater(captured.width,0)
            self.assertEqual(display.take_control(3),'owned')
            request=str(uuid.uuid4());receipt=display.action(request,'tap',{'x':1,'y':1},3)
            self.assertEqual(receipt['state'],'succeeded');self.assertEqual(display.receipt(request,3),receipt)
            self.assertEqual(display.release_control(3),'view-only')
        self.assertEqual(len(self.transports),2)
