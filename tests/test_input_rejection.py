import io
import json
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.display_access import InputDenied
from canaveral.guest import server as guest
from canaveral.guest_access import GuestAccess
from canaveral.model import Error
from canaveral.accessibility import Inspections


class InputRejectionTests(unittest.TestCase):
    def test_receipt_inspection_is_scoped_read_only_and_never_dispatches(self):
        import uuid
        from canaveral.files import save_json
        from canaveral.providers.mobile import operation_receipt
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);operation_id=str(uuid.uuid4())
            report={'state':'unknown','result':{'detail':'Interrupted fixture'}}
            save_json(root/'owned'/'operations'/(operation_id+'.json'),{'fingerprint':'private','report':report})
            self.assertEqual(operation_receipt(root/'owned',operation_id),report)
            self.assertNotIn('fingerprint',operation_receipt(root/'owned',operation_id))
            self.assertNotEqual(operation_receipt(root/'other',operation_id),report)
            with self.assertRaises(Error):operation_receipt(root,'../../owned')

    def test_guest_distinguishes_stale_target_from_unconfirmed_dispatch(self):
        args={'snapshotId':'fixture','nodeId':'node','nativeAction':'click'}
        with patch.object(guest,'INSPECTIONS',Inspections()):
            with self.assertRaises(Error) as refused:guest.control('accessibility-action',args)
            self.assertEqual(refused.exception.code,'input_rejected')
        node={'id':'node','parentId':None,'actions':['click'],'path':[],'name':'target','role':'button','bounds':{}}
        inspection={'snapshotId':'fixture','capturedAt':time.time(),'nodes':[node]}
        cache=Inspections();cache.save('guest',inspection)
        with patch.object(guest,'INSPECTIONS',cache):
            with patch.object(guest.subprocess,'run',return_value=Mock(returncode=42)):
                with self.assertRaises(Error) as refused:guest.control('accessibility-action',args)
                self.assertEqual(refused.exception.code,'input_rejected')
            with patch.object(guest.subprocess,'run',return_value=Mock(returncode=43)):
                with self.assertRaises(Error) as uncertain:guest.control('accessibility-action',args)
                self.assertNotEqual(uncertain.exception.code,'input_rejected')
            with patch.object(guest.subprocess,'run',return_value=Mock(returncode=0)):
                self.assertEqual(guest.control('accessibility-action',args),{'posted':True})
                self.assertNotIn(('guest','fixture'),guest.INSPECTIONS.records)

    def test_guest_access_preserves_only_explicit_predispatch_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'access-token.json').write_text(json.dumps({'token':'fixture-private'}))
            access=GuestAccess({},root)
            with patch.object(access,'tunnel',return_value=1234),patch('canaveral.guest_access.urllib.request.build_opener') as build:
                for code,expected in [('input_rejected',InputDenied),('operation_incomplete',Error),(None,Error)]:
                    payload={'error':'Fixture target response'}
                    if code:payload['code']=code
                    build.return_value.open.side_effect=urllib.error.HTTPError('http://fixture',409,'refused',{},io.BytesIO(json.dumps(payload).encode()))
                    with self.assertRaises(expected) as raised:access.control({'id':'fixture'},{},root,{'action':'accessibility-action','arguments':{}})
                    self.assertEqual(isinstance(raised.exception,InputDenied),code=='input_rejected')


if __name__=='__main__':unittest.main()
