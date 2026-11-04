import uuid
from pathlib import Path

from canaveral.model import Error
from test_runner_sessions import RunnerFixture


class DownloadRecoveryTests(RunnerFixture):
    def test_real_broker_runner_sdk_publishes_verified_file(self):
        data=b'recovery\x00\r\n'*12000;(self.backend.root/'source').write_bytes(data)
        destination=Path(self.temp.name)/'destination'
        request=str(uuid.uuid4())
        result=self.sdk.download_to_file(request,'primary','source',destination)
        self.assertEqual(result['bytes'],len(data));self.assertEqual(destination.read_bytes(),data)
        self.assertEqual(self.wait_receipt(request)['state'],'complete')
        self.assertFalse(list(destination.parent.glob('.canaveral-download-*')))

    def test_source_mutation_preserves_destination_and_never_replays(self):
        (self.backend.root/'source').write_bytes(b'original source');self.backend.mutate_download=True
        destination=Path(self.temp.name)/'destination';destination.write_bytes(b'retained destination')
        request=str(uuid.uuid4())
        with self.assertRaises(Error) as failure:self.sdk.download_to_file(request,'primary','source',destination,replace=True)
        self.assertIn('not replaced',str(failure.exception))
        self.assertEqual(destination.read_bytes(),b'retained destination')
        self.assertFalse(list(destination.parent.glob('.canaveral-download-*')))
        self.assertEqual(self.wait_receipt(request)['state'],'unknown')
