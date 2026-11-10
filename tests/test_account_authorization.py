"""Disposable controller/gateway fixtures; no native runtime acceptance."""
import concurrent.futures
import json
import secrets
import sqlite3
import socket
import threading
import uuid
from unittest.mock import patch

from canaveral.accounts import Accounts, ITERATIONS, password_bytes, password_hash, token_hash
from canaveral.client import Client
from canaveral.dashboard import AuthorizedChannel, AuthorizedReader, AuthorizedRemote, server
from canaveral.model import Error
from canaveral.store import Store
from test_dashboard import DashboardFixture
from test_orchestration import request


def uid():return str(uuid.uuid4())


class IdentityTests(DashboardFixture):
    password='disposable-fixture-password'

    def accounts(self):return Accounts(self.store)

    def identity(self,name,role='user'):
        a=self.accounts()
        user=a.create_user(self.admin,{'id':uid(),'username':name,'role':role},True)
        claim=a.issue_claim(self.admin,'invite',user['id'],True)
        result=a.redeem({'token':claim['token'],'password':self.password})
        return result,Client(self.upstream,result['token'])

    def setup_admin(self):
        result=self.accounts().setup({'username':'admin','password':self.password})
        return result,Client(self.upstream,result['token'])

    def assert_status(self,status,callback):
        with self.assertRaises(Error) as caught:callback()
        self.assertEqual(caught.exception.status,status)

    def test_own_inventory_creation_replay_lifecycle_and_all_domains(self):
        admin,root=self.setup_admin();alice,ac=self.identity('alice');bob,bc=self.identity('bobby')
        self.enroll();value=request()
        machine=ac.request('POST','/v1/machines',value)
        self.assertEqual(machine['ownerId'],alice['user']['id'])
        self.assertEqual(bc.request('GET','/v1/machines'),{'machines':[]})
        self.assertEqual(ac.request('GET','/v1/machines/'+machine['id'])['id'],machine['id'])
        self.assertEqual(len(root.request('GET','/v1/machines')['machines']),1)
        self.assert_status(404,lambda:bc.request('POST','/v1/machines',{**value,'name':'other'}))
        for suffix,body in [('desired',{'state':'stopped'}),('operations',{'id':uid(),'action':'screenshot','arguments':{}}),('power-off',{'id':uid()}),('delete',{'id':uid()}),('authorize',{'action':'access'})]:
            self.assert_status(404,lambda:bc.request('POST','/v1/machines/'+machine['id']+'/'+suffix,body))
        for path in ('hosts','images','image-tasks','image-registry','models','jobs','consumers','connection-setups','resource-budgets','users'):
            self.assert_status(403,lambda:ac.request('GET','/v1/'+path))
        ac.request('GET','/v1/templates')
        self.assert_status(400,lambda:ac.request('POST','/v1/machines',{**request(),'ownerId':bob['user']['id']}))

    def test_admin_can_reinvite_a_disabled_pending_user_without_operator_recovery(self):
        _,admin=self.setup_admin()
        user=admin.request('POST','/v1/users',{'id':uid(),'username':'pendinguser'})
        path='/v1/users/'+user['id']
        old=admin.request('POST',path+'/invite',{})
        admin.request('POST',path+'/update',{'status':'disabled'})
        self.assert_status(401,lambda:Client(self.upstream,'').request('POST','/v1/auth/claim/info',{'token':old['token']}))
        self.assert_status(409,lambda:admin.request('POST',path+'/update',{'status':'active'}))
        pending=admin.request('POST',path+'/update',{'status':'pending'})
        self.assertEqual((pending['id'],pending['status']),(user['id'],'pending'))
        invitation=admin.request('POST',path+'/invite',{})
        admin.request('POST',path+'/update',{'status':'pending'})
        claimed=Client(self.upstream,'').request('POST','/v1/auth/claim',{'token':invitation['token'],'password':self.password})
        self.assertEqual((claimed['user']['id'],claimed['user']['status']),(user['id'],'active'))

    def test_reenable_requires_new_password_and_preserves_machine_ownership(self):
        _,admin=self.setup_admin();alice,client=self.identity('alice');self.enroll()
        machine=client.request('POST','/v1/machines',request())
        pat=client.request('POST','/v1/auth/tokens',{'id':uid(),'name':'before disable','scopes':['machines:read']})
        path='/v1/users/'+alice['user']['id']
        admin.request('POST',path+'/update',{'status':'disabled'})
        admin.request('POST',path+'/update',{'status':'pending'})
        self.assert_status(401,lambda:Client(self.upstream,'').request('POST','/v1/auth/login',{'username':'alice','password':self.password}))
        self.assert_status(401,lambda:Client(self.upstream,pat['token']).request('GET','/v1/machines'))
        invitation=admin.request('POST',path+'/invite',{})
        changed='new-separate-fixture-password'
        result=Client(self.upstream,'').request('POST','/v1/auth/claim',{'token':invitation['token'],'password':changed})
        self.assertEqual(result['user']['id'],alice['user']['id'])
        self.assert_status(401,lambda:Client(self.upstream,'').request('POST','/v1/auth/login',{'username':'alice','password':self.password}))
        self.assertEqual(Client(self.upstream,result['token']).request('GET','/v1/machines')['machines'][0]['id'],machine['id'])

    def test_foreign_receipt_is_hidden_before_absent_target_or_body_comparison(self):
        self.setup_admin();alice,ac=self.identity('alice');bob,bc=self.identity('bobby');self.enroll()
        mid=ac.request('POST','/v1/machines',request())['id']
        op=uid();power=uid();deletion=uid()
        with self.store.transaction() as db:
            host=db.execute('SELECT host FROM machines WHERE id=?',(mid,)).fetchone()[0]
            db.execute('INSERT INTO device_operations VALUES (?,?,?,?,?,?,?,?)',(op,mid,host,'{}','queued',None,self.now,self.now))
            db.execute("INSERT INTO machine_power_offs VALUES (?,?,'queued',?)",(power,mid,self.now))
            db.execute("INSERT INTO machine_deletions VALUES (?,?,'queued',?)",(deletion,mid,self.now))
        self.assert_status(404,lambda:bc.request('GET','/v1/operations/'+op))
        for suffix,body in [('operations',{'id':op,'action':'invalid'}),('power-off',{'id':power}),('delete',{'id':deletion})]:
            self.assert_status(404,lambda:bc.request('POST','/v1/machines/'+uid()+'/'+suffix,body))

    def test_token_scopes_expiry_replay_hashes_and_session_separation(self):
        self.setup_admin();alice,ac=self.identity('alice');self.enroll();mid=ac.request('POST','/v1/machines',request())['id']
        spec={'id':uid(),'name':'read only','scopes':['machines:read'],'expiresInSeconds':60}
        made=ac.request('POST','/v1/auth/tokens',spec);tc=Client(self.upstream,made['token'])
        self.assertNotIn('token',ac.request('POST','/v1/auth/tokens',spec))
        tc.request('GET','/v1/machines/'+mid)
        for path,body in [('/v1/machines',request()),('/v1/auth/tokens',spec),('/v1/auth/logout',{}),('/v1/hosts/enroll',{})]:
            self.assert_status(403 if path=='/v1/machines' else 401,lambda:tc.request('POST',path,body))
        self.assert_status(401,lambda:tc.request('GET','/v1/auth/session'))
        with self.store.transaction() as db:
            row=db.execute('SELECT * FROM api_tokens WHERE id=?',(made['id'],)).fetchone()
            self.assertEqual(row['token_hash'],token_hash(made['token']));last=row['last_used']
        self.now+=30;tc.request('GET','/v1/machines')
        with self.store.transaction() as db:self.assertEqual(db.execute('SELECT last_used FROM api_tokens').fetchone()[0],last)
        self.now+=30;self.assert_status(401,lambda:tc.request('GET','/v1/machines'))
        for ttl in (None,True,59,31536001):
            self.assert_status(400,lambda:ac.request('POST','/v1/auth/tokens',{**spec,'id':uid(),'expiresInSeconds':ttl}))
        self.assert_status(401,lambda:Client(self.upstream,self.admin).request('POST','/v1/auth/tokens',spec))

    def test_current_role_scope_restriction_and_disable_revoke(self):
        admin,root=self.setup_admin();other,oc=self.identity('otheradmin','admin')
        token=root.request('POST','/v1/auth/tokens',{'id':uid(),'name':'admin','scopes':['admin']})
        tc=Client(self.upstream,token['token']);tc.request('GET','/v1/hosts')
        oc.request('POST','/v1/users/'+admin['user']['id']+'/update',{'role':'user'})
        self.assert_status(403,lambda:tc.request('GET','/v1/hosts'))
        self.assert_status(403,lambda:tc.request('GET','/v1/machines'))
        oc.request('POST','/v1/users/'+admin['user']['id']+'/update',{'status':'disabled'})
        self.assert_status(401,lambda:root.request('GET','/v1/machines'))
        self.assert_status(401,lambda:tc.request('GET','/v1/machines'))

    def test_claim_expiry_replay_disable_reset_password_and_unknown_fields(self):
        self.setup_admin();a=self.accounts();user=a.create_user(self.admin,{'id':uid(),'username':'invitee'},True)
        old=a.issue_claim(self.admin,'invite',user['id'],True)
        new=a.issue_claim(self.admin,'invite',user['id'],True)
        self.assert_status(401,lambda:a.redeem({'token':old['token'],'password':self.password}))
        self.now+=86400
        self.assert_status(401,lambda:a.claim_info({'token':new['token']}))
        claim=a.issue_claim(self.admin,'invite',user['id'],True)
        redeemed=a.redeem({'token':claim['token'],'password':self.password})
        self.assert_status(401,lambda:a.redeem({'token':claim['token'],'password':self.password}))
        token=a.tokens(redeemed['token'],{'id':uid(),'name':'test','scopes':['machines:read']})
        reset=a.issue_claim(self.admin,'reset',user['id'],True)
        self.assert_status(401,lambda:a.session(redeemed['token']))
        self.assert_status(401,lambda:a.principal(token['token']))
        a.update_user(self.admin,user['id'],{'status':'disabled'},True)
        self.assert_status(401,lambda:a.redeem({'token':reset['token'],'password':self.password}))
        recovery=a.issue_claim(self.admin,'reset',user['id'],True)
        recovered=a.redeem({'token':recovery['token'],'password':self.password})
        self.assertEqual(recovered['user']['id'],user['id'])
        a.change_password(recovered['token'],{'currentPassword':self.password,'password':self.password+'new'})
        self.assert_status(401,lambda:a.session(recovered['token']))
        self.assert_status(400,lambda:a.login({'username':'admin','password':self.password,'role':'admin'}))

    def test_last_admin_changes_are_transactionally_serialized(self):
        first,_=self.setup_admin();second,_=self.identity('secondadmin','admin');a=self.accounts()
        def disable(user):
            try:a.update_user(self.admin,user['id'],{'status':'disabled'},True);return True
            except Error as e:self.assertEqual(e.status,409);return False
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            self.assertEqual(sum(pool.map(disable,[first['user'],second['user']])),1)
        with self.store.transaction() as db:self.assertEqual(db.execute("SELECT count(*) FROM users WHERE role='admin' AND status='active'").fetchone()[0],1)

    def test_hash_revalidation_prevents_disable_or_reset_login_races(self):
        first,_=self.setup_admin();a=self.accounts();original=password_hash
        def derive(*args,**kwargs):
            result=original(*args,**kwargs)
            a.issue_claim(self.admin,'reset',first['user']['id'],True)
            with self.store.transaction() as db:db.execute('UPDATE users SET password_hash=? WHERE id=?',('0'*64,first['user']['id']))
            return result
        with patch('canaveral.accounts.password_hash',side_effect=derive):
            self.assert_status(401,lambda:a.login({'username':'admin','password':self.password}))

    def test_bootstrap_claim_atomic_backfill_excludes_leases(self):
        self.enroll();normal=self.store.create(request())['id'];leased=self.store.create(request())['id'];a=self.accounts()
        with self.store.transaction() as db:db.execute('INSERT INTO lease_members VALUES (?,?,?)',(uid(),'fixture',leased))
        claim=a.issue_claim(self.admin,'bootstrap',operator=True)
        def redeem(_):
            try:return a.redeem({'token':claim['token'],'username':'firstadmin','password':self.password})
            except Error as e:self.assertEqual(e.status,401)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=[r for r in pool.map(redeem,range(2)) if r]
        self.assertEqual(len(results),1)
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT owner FROM machines WHERE id=?',(normal,)).fetchone()[0],results[0]['user']['id'])
            self.assertIsNone(db.execute('SELECT owner FROM machines WHERE id=?',(leased,)).fetchone()[0])

    def test_concurrent_migration_preserves_password_sessions_and_consumes_legacy(self):
        # The server initialized the empty database. Recreate only the fixture's legacy state.
        self.enroll();mid=self.store.create(request())['id'];a=self.accounts();raw=secrets.token_urlsafe(32);salt=secrets.token_hex(32)
        encoded=password_hash(password_bytes(self.password),salt)
        with self.store.transaction() as db:
            db.execute('DELETE FROM account_migrations')
            db.execute('INSERT INTO administrator VALUES (1,?,?,?,?)',('legacyadmin',salt,encoded,ITERATIONS))
            db.execute('INSERT INTO admin_sessions VALUES (?,?)',(token_hash(raw),self.now+600))
        def initialize(_):return Accounts(Store(self.store.path,clock=lambda:self.now))
        with concurrent.futures.ThreadPoolExecutor(4) as pool:list(pool.map(initialize,range(4)))
        migrated=a.session(raw)['user'];self.assertEqual(migrated['role'],'admin')
        self.assertEqual(a.login({'username':'legacyadmin','password':self.password})['user']['id'],migrated['id'])
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT owner FROM machines WHERE id=?',(mid,)).fetchone()[0],migrated['id'])
            self.assertEqual(db.execute('SELECT count(*) FROM administrator').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM admin_sessions').fetchone()[0],0)
        a.logout(raw)
        # Even an old row inserted after consumption cannot become authority again.
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.transaction() as db:db.execute('INSERT INTO admin_sessions VALUES (?,?)',(token_hash(raw),self.now+600))
        initialize(0);self.assert_status(401,lambda:a.session(raw))

    def test_gateway_all_connectors_hide_foreign_machine_before_touch(self):
        import base64
        from unittest.mock import Mock
        self.setup_admin();alice,ac=self.identity('alice');bob,bc=self.identity('bobby');self.enroll()
        mid=ac.request('POST','/v1/machines',request())['id'];connector=Mock()
        gateway=server(('127.0.0.1',0),self.upstream,desktop_connector=connector,upload_connector=connector,download_connector=connector,accessibility_connector=connector,shell_connector=connector,image_import_connector=connector)
        self.start(gateway);self.url='http://127.0.0.1:'+str(gateway.server_port)
        encoded=base64.urlsafe_b64encode(json.dumps({'path':'/fixture'}).encode()).decode().rstrip('=')
        for suffix,body,headers in [('/accessibility',None,{}),('/files/download/'+encoded,None,{}),('/files/upload',{}, {'X-Canaveral-Path':'/fixture'}),('/desktop',None,{'Origin':self.url,'Upgrade':'websocket'}),('/shells/'+uid()+'/stream',None,{'Origin':self.url,'Upgrade':'websocket'})]:
            self.assertEqual(self.fetch('/api/v1/machines/'+mid+suffix,body,bob['token'],headers)[0],404)
        host=self.store.hosts()[0]['id']
        self.assertEqual(self.fetch('/api/v1/hosts/'+host+'/images/import',{},bob['token'])[0],403)
        connector.assert_not_called()
        self.assertEqual(self.fetch('/api/v1/machines',token=bob['token'],headers={'Cookie':'canaveral_session='+alice['token']})[0],400)
        # Public claim POSTs work without a cookie and return a new cookie only on redemption.
        pending=self.accounts().create_user(self.admin,{'id':uid(),'username':'remoteuser'},True)
        claim=self.accounts().issue_claim(self.admin,'invite',pending['id'],True)
        status,headers,body=self.fetch('/api/v1/auth/claim',{'token':claim['token'],'password':self.password})
        self.assertEqual(status,200);self.assertIn('Set-Cookie',headers);self.assertNotIn('token',json.loads(body))

    def test_io_fences_recheck_after_blocking_reads_and_before_display_writes(self):
        self.setup_admin();alice,ac=self.identity('alice');a=self.accounts()
        def authorized():
            try:a.session(alice['token']);return True
            except Error:return False
        left,right=socket.socketpair();self.addCleanup(left.close);self.addCleanup(right.close)
        reading=threading.Event()
        class BlockingSource:
            def recv(self,size):
                reading.set()
                return left.recv(size)
        remote=AuthorizedRemote(BlockingSource(),authorized)
        def revoke_and_write():
            reading.wait(3)
            a.logout(alice['token']);right.sendall(b'private fixture')
        thread=threading.Thread(target=revoke_and_write);thread.start()
        self.assert_status(401,lambda:remote.recv(100));thread.join()
        alice['token']=a.login({'username':'alice','password':self.password})['token']
        class Source:
            def read(self,size):
                a.logout(alice['token'])
                return b'private fixture'
        reader=AuthorizedReader(Source(),authorized)
        self.assert_status(401,lambda:reader.read(100))
        from unittest.mock import Mock
        channel=Mock();wrapped=AuthorizedChannel(channel,lambda:False)
        for method in (lambda:wrapped.send_bytes(b'private'),lambda:wrapped.send_control({'private':True}),lambda:wrapped.receive(.1)):
            self.assert_status(401,method)
        channel.assert_not_called();self.assertFalse(channel.method_calls)

    def test_reset_last_admin_requires_operator_and_blocks_old_password_immediately(self):
        admin,root=self.setup_admin();a=self.accounts()
        self.assert_status(409,lambda:root.request('POST','/v1/users/'+admin['user']['id']+'/reset-password',{}))
        reset=Client(self.upstream,self.admin).request('POST','/v1/users/'+admin['user']['id']+'/reset-password',{})
        self.assert_status(401,lambda:a.login({'username':'admin','password':self.password}))
        self.assert_status(401,lambda:a.session(admin['token']))
        with self.store.transaction() as db:
            row=db.execute('SELECT * FROM users').fetchone()
            self.assertEqual(row['status'],'pending');self.assertIsNone(row['password_hash'])
        recovered=a.redeem({'token':reset['token'],'password':self.password+'new'})
        self.assertEqual(recovered['user']['id'],admin['user']['id'])

    def test_inventory_scope_cannot_read_operation_output(self):
        self.setup_admin();alice,ac=self.identity('alice');self.enroll()
        mid=ac.request('POST','/v1/machines',request())['id'];op=uid()
        with self.store.transaction() as db:
            host=db.execute('SELECT host FROM machines WHERE id=?',(mid,)).fetchone()[0]
            db.execute('INSERT INTO device_operations VALUES (?,?,?,?,?,?,?,?)',(op,mid,host,'{}','succeeded',json.dumps({'stdout':'private fixture'}),self.now,self.now))
        token=ac.request('POST','/v1/auth/tokens',{'id':uid(),'name':'inventory','scopes':['machines:read']})
        read=Client(self.upstream,token['token'])
        self.assert_status(403,lambda:read.request('GET','/v1/operations/'+op))
        access=ac.request('POST','/v1/auth/tokens',{'id':uid(),'name':'access','scopes':['machines:access']})
        self.assertEqual(Client(self.upstream,access['token']).request('GET','/v1/operations/'+op)['result']['stdout'],'private fixture')

    def test_concurrent_invitation_redemption_and_reduced_token_scopes(self):
        self.setup_admin();a=self.accounts()
        pending=a.create_user(self.admin,{'id':uid(),'username':'claimrace'},True)
        claim=a.issue_claim(self.admin,'invite',pending['id'],True)
        def redeem(_):
            try:return a.redeem({'token':claim['token'],'password':self.password})
            except Error as e:self.assertEqual(e.status,401)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=[r for r in pool.map(redeem,range(2)) if r]
        self.assertEqual(len(results),1)
        token=a.tokens(results[0]['token'],{'id':uid(),'name':'scoped','scopes':['machines:read','machines:access']})
        client=Client(self.upstream,token['token']);client.request('GET','/v1/machines')
        with self.store.transaction() as db:db.execute('UPDATE api_tokens SET scopes=? WHERE id=?',(json.dumps(['machines:access']),token['id']))
        self.assert_status(403,lambda:client.request('GET','/v1/machines'))
        revoked=a.tokens(results[0]['token'],revoke=token['id'])
        self.assertEqual(a.tokens(results[0]['token'],revoke=token['id'])['revokedAt'],revoked['revokedAt'])
        self.assert_status(401,lambda:client.request('GET','/v1/machines'))

    def test_pending_ordinary_user_does_not_block_first_admin_bootstrap(self):
        a=self.accounts()
        a.create_user(self.admin,{'id':uid(),'username':'pendinguser'},True)
        self.assertTrue(a.status()['setupRequired'])
        bootstrap=a.issue_claim(self.admin,'bootstrap',operator=True)
        result=a.redeem({'token':bootstrap['token'],'username':'firstadmin','password':self.password})
        self.assertEqual(result['user']['role'],'admin')
        self.assertFalse(a.status()['setupRequired'])
