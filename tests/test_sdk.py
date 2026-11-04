from lease_fixture import lease_offer
import os
import secrets
import uuid
from pathlib import Path

from canaveral.model import Error
from canaveral.sdk import ConsumerClient
from test_consumers import application
from test_dashboard import DashboardFixture
from test_orchestration import host_offer


class ConsumerSDKTests(DashboardFixture):
    def test_real_http_lifecycle_scoped_key_rotation_and_retry_ids(self):
        host=str(uuid.uuid4());self.store.enroll({'id':host,'credential':secrets.token_urlsafe(32),'offer':lease_offer(host_offer())})
        app=self.store.create_consumer(application());file=Path(self.temp.name)/'application.token';file.write_text(app['credential']+'\n');file.chmod(0o600)
        consumer=ConsumerClient.from_credential_file(self.upstream,file)
        self.assertEqual(len(consumer.catalogue()['templates']),1)
        id=str(uuid.uuid4());lease=consumer.acquire(id,'linux','1','amd64',ttl_seconds=60)
        self.assertEqual(consumer.acquire(id,'linux','1','amd64',ttl_seconds=60)['id'],lease['id'])
        self.assertEqual(consumer.leases()['leases'][0]['id'],id)
        scoped=consumer.scoped_lease(id)
        self.assertEqual(scoped.inspect()['id'],id)
        request=str(uuid.uuid4());renewed=scoped.renew(request,lease['revision'],120)
        self.assertEqual(scoped.renew(request,lease['revision'],120)['mutation'],renewed['mutation'])
        rotated=consumer.scoped_lease(id)
        with self.assertRaises(Error) as raised:scoped.inspect()
        self.assertEqual(raised.exception.code,'unauthenticated');self.assertIsNotNone(raised.exception.request_id)
        self.assertFalse(raised.exception.retryable)
        release=str(uuid.uuid4());ended=rotated.release(release)
        self.assertEqual(ended['lease']['state'],'released');self.assertEqual(ended['lease']['cleanup']['state'],'pending')
        self.assertEqual(rotated.release(release)['mutation'],ended['mutation'])
        self.assertEqual(consumer.inspect(id)['state'],'released')
        if os.name!='nt':
            file.chmod(0o644)
            with self.assertRaises(Error):ConsumerClient.from_credential_file(self.upstream,file)
