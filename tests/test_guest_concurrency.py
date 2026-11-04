import concurrent.futures
import json
import secrets
import tempfile
import threading
import unittest
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from unittest.mock import Mock,patch

from canaveral.guest import server as guest
from canaveral.guest_access import GuestAccess
from canaveral.model import Error


class GuestConcurrencyTests(unittest.TestCase):
    def test_shell_io_does_not_wait_behind_slow_ui_actions(self):
        received=threading.Event();token=secrets.token_urlsafe(32)
        class Handler(guest.Handler):
            def do_POST(self):
                if self.headers.get('X-Test-Action')=='health':received.set()
                super().do_POST()
        service=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=service.serve_forever,daemon=True);thread.start()
        def request(action):
            body=json.dumps({'action':action,'arguments':{'session':str(uuid.uuid4()),'offset':0}}).encode()
            req=urllib.request.Request('http://127.0.0.1:'+str(service.server_port)+'/control',data=body,headers={'Authorization':'Bearer '+token,'X-Test-Action':action})
            with urllib.request.urlopen(req,timeout=3) as response:return json.loads(response.read())
        try:
            with patch.object(guest,'TOKEN',token),patch.object(guest,'control',side_effect=lambda action,args:{'action':action}),concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                with guest.LOCK:
                    waiting=pool.submit(request,'health');self.assertTrue(received.wait(1))
                    self.assertEqual(pool.submit(request,'shell-read').result(timeout=2),{'action':'shell-read'})
                    self.assertFalse(waiting.done())
                self.assertEqual(waiting.result(timeout=2),{'action':'health'})
        finally:service.shutdown();service.server_close();thread.join(2)

    def test_failed_ssh_connections_back_off_before_spawning_another_client(self):
        with tempfile.TemporaryDirectory() as directory:
            access=GuestAccess({},directory);key=('fixture',8769)
            with patch('canaveral.guest_access.time.monotonic',return_value=100):
                access.connection_failed(key)
                with patch.object(access,'host') as host:
                    with self.assertRaises(Error):access.tunnel({'id':'fixture'},{},directory,8769)
                    host.assert_not_called()
                for _ in range(10):access.connection_failed(key)
                self.assertEqual(access.retry_at[key],160)
                access.connection_succeeded(key)
                self.assertNotIn(key,access.retry_at);self.assertNotIn(key,access.connection_failures)
