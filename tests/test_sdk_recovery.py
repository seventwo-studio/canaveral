import contextlib
import http.client
import json
import unittest
import uuid
from unittest.mock import Mock

from canaveral.client import Client
from canaveral.model import Error
from canaveral.sdk import ConsumerClient,LeaseClient
from test_access_sessions import AccessFixture


class HTTPRecoveryTests(unittest.TestCase):
    def test_unconfirmed_mutation_preserves_uuid_without_retry_or_peer_details(self):
        request=str(uuid.uuid4())
        for problem in (http.client.IncompleteRead(b'private-content',100),
                        http.client.RemoteDisconnected('private-peer'),OSError('private-socket')):
            with self.subTest(problem=type(problem).__name__):
                client=Client('http://127.0.0.1:1','x'*43);client.opener.open=Mock(side_effect=problem)
                with self.assertRaises(Error) as failure:client.request('POST','/v1/leases',{'id':request})
                error=failure.exception
                self.assertEqual((error.status,error.request_id,error.outcome,error.retryable),(503,request,'unknown',False))
                self.assertNotIn('private-',str(error));client.opener.open.assert_called_once()

    def test_read_failure_remains_retryable_without_claiming_mutation_outcome(self):
        client=Client('http://127.0.0.1:1','x'*43)
        client.opener.open=Mock(side_effect=http.client.RemoteDisconnected())
        with self.assertRaises(Error) as failure:client.request('GET','/v1/leases')
        self.assertTrue(failure.exception.retryable);self.assertIsNone(failure.exception.outcome)
        client.opener.open.assert_called_once()

    def test_invalid_success_body_has_typed_uncertainty_without_automatic_retry(self):
        for body in (b'{"private-content":',b'\xff'):
            client=Client('http://127.0.0.1:1','x'*43);response=Mock();response.read.return_value=body
            client.opener.open=Mock();client.opener.open.return_value.__enter__=Mock(return_value=response)
            client.opener.open.return_value.__exit__=Mock(return_value=False)
            with self.assertRaises(Error) as failure:client.request('POST','/v1/leases/x/credential',{})
            self.assertEqual((failure.exception.code,failure.exception.outcome,failure.exception.retryable),
                             ('response_invalid','unknown',False))
            self.assertIsNone(failure.exception.request_id);self.assertNotIn('private-content',str(failure.exception))
            client.opener.open.assert_called_once()


class LifecycleRecoveryTests(AccessFixture):
    @contextlib.contextmanager
    def lose_response(self,client):
        """Consume an actual fixture HTTP response, then discard its receipt."""
        original=client.opener.open;seen=[]
        @contextlib.contextmanager
        def opened(*args,**kwargs):
            with original(*args,**kwargs) as response:
                class Lost:
                    def read(self,limit):
                        seen.append(json.loads(response.read(limit)))
                        raise http.client.IncompleteRead(b'',1)
                yield Lost()
        client.opener.open=opened
        try:yield seen
        finally:client.opener.open=original

    def assert_unknown(self,failure,request):
        self.assertEqual((failure.exception.request_id,failure.exception.outcome,failure.exception.retryable),
                         (request,'unknown',False))

    def test_acquire_response_loss_inspection_and_explicit_identical_request(self):
        consumer=ConsumerClient(self.upstream,self.a['credential']);request=str(uuid.uuid4())
        with self.lose_response(consumer.client) as seen:
            with self.assertRaises(Error) as failure:consumer.acquire(request,'android-phone','1','arm64',ttl_seconds=120)
        self.assert_unknown(failure,request);self.assertEqual(len(seen),1)
        self.assertEqual(consumer.inspect(request)['id'],request)
        replay=consumer.acquire(request,'android-phone','1','arm64',ttl_seconds=120)
        self.assertEqual(replay['members'],seen[0]['members'])
        self.assertEqual(len(consumer.leases()['leases']),2) # Original fixture lease plus this acquisition.

    def test_renew_response_loss_inspection_and_explicit_identical_request(self):
        self.ready();scoped=LeaseClient(self.upstream,self.lease['id'],self.token)
        before=scoped.inspect();request=str(uuid.uuid4())
        with self.lose_response(scoped.client) as seen:
            with self.assertRaises(Error) as failure:scoped.renew(request,before['revision'],180)
        self.assert_unknown(failure,request);self.assertEqual(len(seen),1)
        after=scoped.inspect();self.assertEqual(after['revision'],before['revision']+1)
        replay=scoped.renew(request,before['revision'],180)
        self.assertEqual(replay['mutation'],seen[0]['mutation'])
        self.assertEqual(scoped.inspect()['revision'],after['revision'])

    def test_release_response_loss_keeps_same_cleanup_intent(self):
        self.ready();scoped=LeaseClient(self.upstream,self.lease['id'],self.token);request=str(uuid.uuid4())
        with self.lose_response(scoped.client) as seen:
            with self.assertRaises(Error) as failure:scoped.release(request)
        self.assert_unknown(failure,request);self.assertEqual(len(seen),1)
        inspected=scoped.inspect();self.assertEqual(inspected['state'],'released')
        replay=scoped.release(request)
        self.assertEqual(replay['mutation'],seen[0]['mutation'])
        self.assertEqual(replay['lease']['members'],inspected['members'])
        self.assertEqual(replay['lease']['members'],seen[0]['lease']['members'])

    def test_credential_response_loss_does_not_rotate_again_or_invent_a_retry_id(self):
        consumer=ConsumerClient(self.upstream,self.a['credential'])
        with self.lose_response(consumer.client) as seen:
            with self.assertRaises(Error) as failure:consumer.scoped_lease(self.lease['id'])
        self.assert_unknown(failure,None);self.assertEqual(len(seen),1)
        self.assertNotIn('Reuse',str(failure.exception))
        self.assertNotIn(seen[0]['credential'],str(failure.exception))
        self.assertEqual(consumer.inspect(self.lease['id'])['id'],self.lease['id'])
        old=LeaseClient(self.upstream,self.lease['id'],self.token)
        with self.assertRaises(Error) as revoked:old.inspect()
        self.assertEqual(revoked.exception.code,'unauthenticated')

    def test_session_response_loss_preserves_generation_for_inspection(self):
        self.ready();scoped=LeaseClient(self.upstream,self.lease['id'],self.token);request=str(uuid.uuid4())
        with self.lose_response(scoped.client) as seen:
            with self.assertRaises(Error) as failure:scoped.create_session(request,'primary','pty')
        self.assert_unknown(failure,request);self.assertEqual(len(seen),1)
        inspected=scoped.session(request)
        self.assertEqual(inspected['generation'],seen[0]['generation'])
        self.assertEqual(scoped.create_session(request,'primary','pty')['generation'],inspected['generation'])
        self.assertEqual(inspected['state'],'pending')

    def test_operation_response_loss_recovers_same_durable_intent_without_retry(self):
        self.ready();scoped=LeaseClient(self.upstream,self.lease['id'],self.token);request=str(uuid.uuid4())
        with self.lose_response(scoped.client) as seen:
            with self.assertRaises(Error) as failure:scoped.create_operation(request,'primary','tap',{'x':1,'y':2})
        self.assert_unknown(failure,request);self.assertEqual(len(seen),1)
        inspected=scoped.operation(request)
        self.assertEqual(inspected,seen[0])
        self.assertEqual(scoped.create_operation(request,'primary','tap',{'x':1,'y':2}),inspected)
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM device_operations WHERE id=?',(request,)).fetchone()[0],1)
