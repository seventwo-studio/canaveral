import base64
import json
import secrets
import uuid

from test_dashboard import DashboardFixture
from test_devices import config, create, operation


class DashboardControlTests(DashboardFixture):
    def test_operations_require_auth_and_cookie_origin_and_return_binary_receipts(self):
        host, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        offered = config()
        self.store.enroll({'id': host, 'credential': token, 'offer': offered})
        machine = create(self.store)
        heartbeat = {'offer': offered, 'reports': {machine['id']: {'state': 'running'}}}
        self.store.heartbeat(host, token, heartbeat)
        route = '/api/v1/machines/' + machine['id'] + '/operations'
        request = operation()
        self.assertEqual(self.fetch(route, request)[0], 401)
        self.assertEqual(self.fetch(route, request, token=self.admin, headers={'Origin': 'https://evil.example'})[0], 403)
        status, _, body = self.fetch(route, request, token=self.admin)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['state'], 'queued')
        self.assertEqual(self.store.heartbeat(host, token, heartbeat)['deviceOperations'][0]['id'], request['id'])
        payload = base64.b64encode(b'png' * 400000).decode()
        self.store.heartbeat(host, token, {**heartbeat, 'deviceReports': {request['id']: {'state': 'succeeded', 'result': {'data': payload, 'mediaType': 'image/png'}}}})
        status, _, body = self.fetch('/api/v1/operations/' + request['id'], token=self.admin)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['result']['data'], payload)
        self.assertEqual(self.fetch('/api/v1/operations/' + request['id'])[0], 401)
        self.assertEqual(self.fetch('/api/v1/operations/not-a-uuid', token=self.admin)[0], 404)

    def test_streamed_upload_bypasses_json_envelope_but_keeps_auth_and_origin(self):
        from canaveral.dashboard import server
        from canaveral.transfers import copy_upload
        import io
        captured=io.BytesIO()
        def connector(machine,path=None,app=None,reader=None,size=None,authorized=None,check_only=False):
            if check_only:return True
            copy_upload(reader,captured,size,authorized)
            return {'uploaded':size}
        service=server(('127.0.0.1',0),self.upstream,bootstrap_token=self.admin,upload_connector=connector)
        self.start(service);self.url='http://127.0.0.1:'+str(service.server_port)
        route='/api/v1/machines/'+str(uuid.uuid4())+'/files/upload'
        payload=b'x'*(2*1024*1024+13)
        headers={'Content-Type':'application/octet-stream','X-Canaveral-Path':'%2Fhome%2Fdesktop%2Flarge.bin'}
        self.assertEqual(self.fetch(route,raw=b'x',headers=headers)[0],401)
        self.assertEqual(self.fetch(route,raw=b'x',token=self.admin,headers={**headers,'Origin':'https://other.example'})[0],403)
        status,_,body=self.fetch(route,raw=payload,token=self.admin,headers=headers)
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['uploaded'],len(payload))
        self.assertEqual(captured.getvalue(),payload)

    def test_live_inspection_is_authenticated_and_does_not_create_operation_receipts(self):
        from canaveral.dashboard import server
        calls=[]
        service=server(('127.0.0.1',0),self.upstream,accessibility_connector=lambda machine:(calls.append(machine) or {'nodes':[],'source':'fixture'}))
        self.start(service);self.url='http://127.0.0.1:'+str(service.server_port)
        route='/api/v1/machines/'+str(uuid.uuid4())+'/accessibility'
        self.assertEqual(self.fetch(route)[0],401)
        self.assertFalse(calls)
        for _ in range(2):self.assertEqual(self.fetch(route,token=self.admin)[0],200)
        self.assertEqual(len(calls),2)
        with self.store.transaction() as db:self.assertEqual(db.execute('SELECT count(*) FROM device_operations').fetchone()[0],0)
