import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch

from canaveral.accessibility import Inspections
from canaveral.guest import server as guest
from canaveral.guest_access import helper_files
from canaveral.model import Error


class GuestInspectionTests(unittest.TestCase):
    def test_guest_expiry_uses_elapsed_capture_age_before_native_dispatch(self):
        elapsed=[100];cache=Inspections(clock=lambda:elapsed[0])
        data={'nodes':[{'id':'ax-1','actions':['click']}],'truncated':False}
        with patch.object(guest,'INSPECTIONS',cache),patch.object(guest.subprocess,'run',return_value=Mock(stdout=json.dumps(data).encode())) as run:
            tree=guest.control('accessibility',{'includeFrame':False})
            self.assertNotIn('frame',tree);self.assertEqual(run.call_count,1)
            with patch.object(guest.time,'time',return_value=tree['capturedAt']-3600):
                elapsed[0]=115
                with self.assertRaises(Error) as failure:
                    guest.control('accessibility-action',{'snapshotId':tree['snapshotId'],'nodeId':'ax-1','nativeAction':'click'})
            self.assertEqual(failure.exception.code,'input_rejected');self.assertEqual(run.call_count,1)

    def test_slow_native_capture_does_not_get_a_new_lifetime_on_return(self):
        elapsed=[100];cache=Inspections(clock=lambda:elapsed[0])
        def delayed(*args,**kwargs):
            elapsed[0]=116;return Mock(stdout=b'{"nodes":[],"truncated":false}')
        with patch.object(guest,'INSPECTIONS',cache),patch.object(guest.subprocess,'run',side_effect=delayed):
            tree=guest.control('accessibility',{'includeFrame':False})
            with self.assertRaises(Error):cache.get('guest',tree['snapshotId'])

    def test_generated_guest_helpers_import_with_their_complete_dependency_set(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            for item in helper_files():
                path=root/pathlib.PurePosixPath(item['path']).relative_to('/opt/canaveral')
                path.parent.mkdir(parents=True,exist_ok=True);path.write_text(item['content'])
            (root/'canaveral/__init__.py').write_text('')
            code='import sys;sys.path.insert(0,sys.argv[1]);import server;assert server.INSPECTIONS.clock()>0'
            result=subprocess.run([sys.executable,'-I','-c',code,str(root)],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
