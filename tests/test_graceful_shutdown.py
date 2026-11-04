import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from canaveral.guest_access import GuestAccess
from canaveral.model import Error
from canaveral.providers.apple import Apple


class GracefulShutdownTests(unittest.TestCase):
    def test_preparation_syncs_access_identity_before_ready_marker(self):
        from canaveral.guest_access import desktop_recipe
        from canaveral.files import save_json
        import uuid
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);machine={'id':str(uuid.uuid4())}
            save_json(path/'access-token.json',{'token':'x'*43});(path/'ssh_host_ed25519_key').write_text('fixture-private');(path/'ssh_host_ed25519_key.pub').write_text('ssh-ed25519 fixture-public')
            access=GuestAccess({'guestAccess':{}},directory)
            image={'prepare':desktop_recipe('ssh-ed25519 fixture-public')}
            old=next(f for f in image['prepare']['files'] if f['path']=='/opt/canaveral/server.py');old['content']='older management helper'
            prepared=access.prepare(machine,image,path)
            self.assertEqual(old['content'],'older management helper')
            installed=next(f for f in prepared['prepare']['files'] if f['path']=='/opt/canaveral/server.py')
            self.assertIn('durableWrites',installed['content'])
            last=prepared['prepare']['commands'][-1]
            self.assertTrue(last.startswith('sync; touch /var/lib/canaveral/'+machine['id']+'/complete; sync;'))
            self.assertIn('touch /opt/canaveral/prepared; sync',last)
            self.assertNotIn('touch /opt/canaveral/prepared',prepared['prepare']['commands'][:-1])
    def test_uncertain_shutdown_is_not_replayed_but_new_boot_can_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            access=GuestAccess({},directory)
            access.control=Mock(side_effect=[{},Error('Lost shutdown response')])
            with self.assertRaises(Error):access.shutdown({}, {}, directory, 100)
            access.shutdown({}, {}, directory, 100)
            self.assertEqual(access.control.call_count,2)
            self.assertIn('systemctl poweroff',access.control.call_args.args[-1]['arguments']['text'])
            access.control=Mock(return_value={})
            access.shutdown({}, {}, directory, 200)
            self.assertEqual(access.control.call_count,2)

    def test_open_failure_can_retry_without_replaying_poweroff(self):
        with tempfile.TemporaryDirectory() as directory:
            access=GuestAccess({},directory);access.control=Mock(side_effect=Error('Not connected'))
            with self.assertRaises(Error):access.shutdown({}, {}, directory, 100)
            self.assertFalse((Path(directory)/'guest-shutdown.json').exists())

    def test_old_stopped_status_does_not_confirm_latest_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);provider=Apple({},directory)
            (path/'runner-launch.json').write_text(json.dumps({'attemptedAt':978307210}))
            self.assertFalse(provider.confirmed_stopped(path))
            for phase,stamp,expected in [('Stopped',9,False),('Running',11,False),('Stopped',11,True)]:
                (path/'status.json').write_text(json.dumps({'phase':phase,'updatedAt':stamp}))
                self.assertEqual(provider.confirmed_stopped(path),expected)

    def test_forced_stop_receipt_cannot_confirm_a_later_boot_or_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);provider=Apple({},directory)
            (path/'runner-launch.json').write_text(json.dumps({'attemptedAt':100}))
            (path/'status.json').write_text(json.dumps({'phase':'Running','updatedAt':100-978307200}))
            (path/'fenced-stop.json').write_text(json.dumps({'boot':100,'stoppedAt':101,'consistency':'crash-consistent'}))
            self.assertTrue(provider.confirmed_stopped(path))
            (path/'runner-launch.json').write_text(json.dumps({'attemptedAt':102}))
            self.assertFalse(provider.confirmed_stopped(path))
            (path/'runner-launch.json').write_text(json.dumps({'attemptedAt':100}))
            (path/'status.json').write_text(json.dumps({'phase':'Running','updatedAt':103-978307200}))
            self.assertFalse(provider.confirmed_stopped(path))
