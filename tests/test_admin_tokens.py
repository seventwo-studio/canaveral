"""Disposable admin-token controller/gateway checks; no native acceptance."""
import json
import uuid

from canaveral.accounts import Accounts, token_hash
from canaveral.client import Client
from canaveral.dashboard import AuthorizedRemote
from canaveral.model import Error
from test_dashboard import DashboardFixture
from test_orchestration import request


def uid():return str(uuid.uuid4())


class AdminTokenTests(DashboardFixture):
    password='disposable-admin-token-password'
    public_keys={'id','userId','name','scopes','createdAt','expiresAt','lastUsedAt','revokedAt','prefix'}

    def setUp(self):
        super().setUp()
        self.accounts=Accounts(self.store)
        self.identity=self.accounts.setup({'username':'admin','password':self.password})
        self.root=Client(self.upstream,self.identity['token'])

    def user(self,name,role='user'):
        user=self.accounts.create_user(self.admin,{'id':uid(),'username':name,'role':role},True)
        claim=self.accounts.issue_claim(self.admin,'invite',user['id'],True)
        session=self.accounts.redeem({'token':claim['token'],'password':self.password})
        return session,Client(self.upstream,session['token'])

    def mint(self,client,scopes=None,**overrides):
        return client.request('POST','/v1/auth/tokens',{'id':uid(),'name':'fixture token','scopes':scopes or ['machines:read'],**overrides})

    def assert_status(self,status,callback):
        with self.assertRaises(Error) as caught:callback()
        self.assertEqual(caught.exception.status,status)

    def test_list_is_safe_all_user_metadata_with_stable_order_and_terminal_records(self):
        alice,client=self.user('alice')
        first=self.mint(client,id='00000000-0000-4000-8000-000000000002')
        second=self.mint(self.root,['admin'],id='00000000-0000-4000-8000-000000000001')
        self.now+=1
        expired=self.mint(client,expiresInSeconds=60)
        client.request('POST','/v1/auth/tokens/'+first['id']+'/revoke',{})
        self.now+=60
        result=self.root.request('GET','/v1/admin/tokens')
        self.assertEqual(set(result),{'tokens'})
        self.assertEqual([t['id'] for t in result['tokens']],[second['id'],first['id'],expired['id']])
        self.assertEqual([t['userId'] for t in result['tokens']],[self.identity['user']['id'],alice['user']['id'],alice['user']['id']])
        for row in result['tokens']:self.assertEqual(set(row),self.public_keys)
        encoded=json.dumps(result)
        for token in (first,second,expired):
            self.assertNotIn(token['token'],encoded)
            self.assertNotIn(token_hash(token['token']),encoded)
        self.assertNotIn(self.identity['token'],encoded)
        self.assertNotIn(token_hash(self.identity['token']),encoded)
        self.assertEqual(result['tokens'][1]['revokedAt'],1001)
        self.assertLessEqual(result['tokens'][2]['expiresAt'],self.now)
        personal=client.request('GET','/v1/auth/tokens')
        self.assertTrue(all('userId' not in row for row in personal['tokens']))

    def test_session_admin_pat_and_operator_can_list_and_revoke(self):
        alice,client=self.user('alice')
        administrative=self.mint(self.root,['admin'])
        actors=(self.root,Client(self.upstream,administrative['token']),Client(self.upstream,self.admin))
        for actor in actors:
            with self.subTest(credential=actors.index(actor)):
                target=self.mint(client)
                self.assertIn(target['id'],[r['id'] for r in actor.request('GET','/v1/admin/tokens')['tokens']])
                result=actor.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{})
                self.assertEqual(set(result),self.public_keys)
                self.assertEqual((result['id'],result['userId'],result['revokedAt']),(target['id'],alice['user']['id'],self.now))
                self.assert_status(401,lambda:Client(self.upstream,target['token']).request('GET','/v1/machines'))

    def test_users_and_read_only_administrator_tokens_cannot_list_or_revoke(self):
        _,client=self.user('alice')
        user_pat=self.mint(client)
        read_only=self.mint(self.root)
        target=self.mint(client)
        for actor in (client,Client(self.upstream,user_pat['token']),Client(self.upstream,read_only['token'])):
            self.assert_status(403,lambda:actor.request('GET','/v1/admin/tokens'))
            self.assert_status(403,lambda:actor.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{}))
            self.assert_status(403,lambda:self.accounts.admin_tokens(actor.token))
        self.assertIsNone(client.request('GET','/v1/auth/tokens')['tokens'][-1]['revokedAt'])

    def test_demotion_disable_and_revoked_credentials_are_checked_on_each_call(self):
        _,other=self.user('otheradmin','admin')
        administrative=self.mint(self.root,['admin'])
        pat=Client(self.upstream,administrative['token'])
        target=self.mint(other)
        self.root.request('GET','/v1/admin/tokens');pat.request('GET','/v1/admin/tokens')
        path='/v1/users/'+self.identity['user']['id']+'/update'
        other.request('POST',path,{'role':'user'})
        for actor in (self.root,pat):
            self.assert_status(403,lambda:actor.request('GET','/v1/admin/tokens'))
            self.assert_status(403,lambda:actor.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{}))
        other.request('POST',path,{'role':'admin'})
        pat.request('GET','/v1/admin/tokens')
        other.request('POST',path,{'status':'disabled'})
        for actor in (self.root,pat):
            self.assert_status(401,lambda:actor.request('GET','/v1/admin/tokens'))
            self.assert_status(401,lambda:actor.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{}))
        fresh=self.mint(other,['admin']);fresh_client=Client(self.upstream,fresh['token'])
        other.request('POST','/v1/admin/tokens/'+fresh['id']+'/revoke',{})
        self.assert_status(401,lambda:fresh_client.request('GET','/v1/admin/tokens'))

    def test_unknown_target_and_invalid_body_never_mutate_or_mint(self):
        target=self.mint(self.root)
        self.assert_status(404,lambda:self.root.request('POST','/v1/admin/tokens/'+uid()+'/revoke',{}))
        self.assert_status(400,lambda:self.root.request('POST','/v1/admin/tokens/not-a-uuid/revoke',{}))
        self.assert_status(400,lambda:self.root.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{'userId':self.identity['user']['id']}))
        self.assert_status(404,lambda:self.root.request('POST','/v1/admin/tokens',{'id':uid(),'userId':self.identity['user']['id']}))
        self.assert_status(404,lambda:self.root.request('GET','/v1/admin/tokens/'+target['id']))
        rows=self.root.request('GET','/v1/admin/tokens')['tokens']
        self.assertEqual(len(rows),1);self.assertIsNone(rows[0]['revokedAt'])

    def test_revoke_replay_preserves_original_timestamp_and_owner_session(self):
        alice,client=self.user('alice')
        target=self.mint(client)
        path='/v1/admin/tokens/'+target['id']+'/revoke'
        first=self.root.request('POST',path,{})
        self.now+=50
        self.assertEqual(self.root.request('POST',path,{}),first)
        self.assertEqual(client.request('GET','/v1/auth/session')['user']['id'],alice['user']['id'])
        self.assert_status(401,lambda:Client(self.upstream,target['token']).request('GET','/v1/machines'))

    def test_admin_pat_can_revoke_itself_and_then_is_rejected(self):
        target=self.mint(self.root,['admin'])
        actor=Client(self.upstream,target['token'])
        result=actor.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{})
        self.assertEqual(result['revokedAt'],self.now)
        self.assert_status(401,lambda:actor.request('GET','/v1/admin/tokens'))
        self.assert_status(401,lambda:actor.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{}))
        self.assertEqual(self.root.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{}),result)
        self.root.request('GET','/v1/auth/session')

    def test_logged_out_admin_session_is_rejected_by_controller_and_gateway(self):
        target=self.mint(self.root)
        self.root.request('POST','/v1/auth/logout',{})
        self.assert_status(401,lambda:self.root.request('GET','/v1/admin/tokens'))
        self.assert_status(401,lambda:self.root.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{}))
        cookie={'Cookie':'canaveral_session='+self.identity['token']}
        self.assertEqual(self.fetch('/api/v1/admin/tokens',headers=cookie)[0],401)
        self.assertEqual(self.fetch('/api/v1/admin/tokens/'+target['id']+'/revoke',{},headers={**cookie,'Origin':self.url})[0],401)

    def test_gateway_exposes_only_fixed_admin_routes_and_preserves_credential_rules(self):
        alice,client=self.user('alice')
        target=self.mint(client)
        cookie={'Cookie':'canaveral_session='+self.identity['token']}
        self.assertEqual(self.fetch('/api/v1/admin/tokens',headers=cookie)[0],200)
        self.assertEqual(self.fetch('/api/v1/admin/tokens',token=alice['token'])[0],403)
        path='/api/v1/admin/tokens/'+target['id']+'/revoke'
        self.assertEqual(self.fetch(path,{},headers=cookie)[0],403)
        self.assertEqual(self.fetch(path,{},headers={**cookie,'Origin':'https://foreign.example'})[0],403)
        self.assertEqual(self.fetch(path,{},token=self.identity['token'],headers=cookie)[0],400)
        self.assertEqual(self.fetch('/api/v1/admin/tokens',headers={**cookie,'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.fetch('/api/v1/admin/tokens',{'id':uid()},headers={**cookie,'Origin':self.url})[0],404)
        self.assertEqual(self.fetch('/api/v1/admin/tokens/'+target['id'],headers=cookie)[0],404)
        self.assertEqual(self.fetch(path,{'extra':True},headers={**cookie,'Origin':self.url})[0],400)
        status,_,body=self.fetch(path,{},headers={**cookie,'Origin':self.url})
        self.assertEqual(status,200)
        result=json.loads(body)
        self.assertEqual(set(result),self.public_keys)
        self.assertEqual(result['userId'],alice['user']['id'])
        self.assertEqual(self.fetch('/api/v1/auth/session',headers=cookie)[0],200)

    def test_gateway_allows_admin_pat_and_rejects_other_pat_scopes(self):
        _,client=self.user('alice')
        target=self.mint(client)
        admin_pat=self.mint(self.root,['admin'])
        for token in (self.mint(self.root)['token'],self.mint(client)['token']):
            self.assertEqual(self.fetch('/api/v1/admin/tokens',token=token)[0],403)
            self.assertEqual(self.fetch('/api/v1/admin/tokens/'+target['id']+'/revoke',{},token)[0],403)
        self.assertEqual(self.fetch('/api/v1/admin/tokens',token=admin_pat['token'])[0],200)
        self.assertEqual(self.fetch('/api/v1/admin/tokens/'+target['id']+'/revoke',{},admin_pat['token'])[0],200)

    def test_revocation_fences_existing_connection_after_blocking_read(self):
        _,client=self.user('alice');self.enroll()
        machine=client.request('POST','/v1/machines',request())
        target=self.mint(client,['machines:access'])
        actor=Client(self.upstream,target['token'])
        def authorized():
            try:
                actor.request('POST','/v1/machines/'+machine['id']+'/authorize',{'action':'access'})
                return True
            except Error:return False
        self.assertTrue(authorized())
        root=self.root
        class Source:
            def recv(self,size):
                root.request('POST','/v1/admin/tokens/'+target['id']+'/revoke',{})
                return b'private fixture'
        remote=AuthorizedRemote(Source(),authorized)
        self.assert_status(401,lambda:remote.recv(1024))
        self.assertFalse(authorized())
