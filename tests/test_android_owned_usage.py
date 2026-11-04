import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import Mock,patch

from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.host_health import _process_state,process_usage
from canaveral.model import Error,digest
from canaveral.owned_usage import child_birth
from canaveral.providers.android import Android
from test_devices import config,mobile
from test_owned_usage import Collector,Process


@unittest.skipUnless(hasattr(os,'getuid'),'Android runtime ownership requires POSIX.')
class AndroidUsageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();_process_state.samples={}
        self.provider=Android(config(storage=str(self.root/'storage'),androidSDK=str(self.root/'sdk')),self.root/'state')
        self.machine={'id':str(uuid.uuid4()),'template':mobile(),'resources':{'cpu':2,'memoryMiB':2048,'diskGiB':8},'desired':'running','observed':'running'}
        self.folder=self.root/'assignment';self.folder.mkdir();self.storage=self.provider.storage(self.machine)
        fingerprint=digest({key:self.machine[key] for key in ('id','template','resources')})
        save_json(self.folder/'assignment.json',{'fingerprint':fingerprint})
        save_json(self.storage/'avd-created.json',{'name':self.provider.name(self.machine)})
        save_json(self.storage/'endpoint.json',{'port':5554})
        self.launch={'version':2,'bootId':str(uuid.uuid4()),'machineId':self.machine['id'],'leaseId':None,
                     'fingerprint':fingerprint,'argv':self.provider.launch_arguments(self.machine,5554),
                     'startedAt':100,'pid':99,'processStartedAt':100.5}
        save_json(self.storage/'launch.json',self.launch)
        self.vm=Process(99,100.5,'qemu-system-aarch64',4*1048576)
        self.vm.binary=str(self.root/'sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64')
        self.vm.arguments=[self.vm.binary,*self.launch['argv'][1:]]
        self.collector=Collector(Process(1,50),self.vm)
        self.platform=patch('canaveral.owned_usage.platform.system',return_value='Darwin');self.platform.start();self.addCleanup(self.platform.stop)
        self.arch=patch('canaveral.owned_usage.platform.machine',return_value='arm64');self.arch.start();self.addCleanup(self.arch.stop)
        self.provider.adb=Mock(side_effect=AssertionError('Resource observation must not contact ADB'))
        self.provider.devices=Mock(side_effect=AssertionError('Resource observation must not enumerate devices'))

    def observe(self):return self.provider.resource_processes(self.machine,self.machine['template'],self.folder,self.collector)

    def test_restart_observation_pins_launcher_and_qemu_without_writing_or_device_calls(self):
        before={p:p.read_bytes() for p in self.root.rglob('*.json')}
        for executable in (self.vm.binary,self.provider.tool('emulator'),self.vm.binary+'-headless'):
            self.vm.binary=executable;self.vm.arguments=[executable,*self.launch['argv'][1:]]
            self.assertEqual(self.observe(),[(self.vm,100.5,'simulators')])
        self.assertEqual(before,{p:p.read_bytes() for p in self.root.rglob('*.json')})
        self.assertEqual(self.provider.processes,{})
        self.provider.adb.assert_not_called();self.provider.devices.assert_not_called()

    def test_linux_x86_64_layout_and_unknown_host_layouts(self):
        self.machine['template']['arch']='amd64'
        self.machine['template']['device']['systemImage']='system-images;android-35;google_apis;x86_64'
        fingerprint=digest({key:self.machine[key] for key in ('id','template','resources')})
        for path in (self.folder/'assignment.json',self.storage/'canaveral-owner.json'):
            save_json(path,{'fingerprint':fingerprint})
        self.launch['fingerprint']=fingerprint;save_json(self.storage/'launch.json',self.launch)
        self.vm.binary=str(self.root/'sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64')
        self.vm.arguments=[self.vm.binary,*self.launch['argv'][1:]]
        with patch('canaveral.owned_usage.platform.system',return_value='Linux'),patch('canaveral.owned_usage.platform.machine',return_value='x86_64'):
            self.assertEqual(self.observe(),[(self.vm,100.5,'simulators')])
        for system,arch in [('Windows','x86_64'),('Linux','unsupported')]:
            with self.subTest(system=system,arch=arch),patch('canaveral.owned_usage.platform.system',return_value=system),patch('canaveral.owned_usage.platform.machine',return_value=arch):
                with self.assertRaises(Error):self.observe()

    def test_owned_descendants_and_tree_duplicates_are_measured_once(self):
        child=Process(100,101,'gpu-helper',2*1048576);self.vm.descendants=[child]
        self.collector.processes[100]=child;self.collector.root.descendants=[self.vm,child]
        owned=lambda api:(self.provider.resource_processes(self.machine,self.machine['template'],self.folder,api),set())
        with patch('canaveral.host_health.time.monotonic',side_effect=[10,12]):
            first=process_usage(self.collector,owned);self.vm.cpu=2;child.cpu=2
            second=process_usage(self.collector,owned)
        group=second['categories'][2]
        self.assertEqual((group['processCount'],group['memoryMiB'],group['cpuPercent']),(2,6,25))
        self.assertIsNone(first['categories'][2]['cpuPercent']);self.assertEqual(child.reads,2)

    def test_legacy_incomplete_or_malformed_launches_never_discover_by_name(self):
        invalid=[{'pid':99,'startedAt':100,'argv':self.launch['argv']},
                 {k:v for k,v in self.launch.items() if k!='processStartedAt'},
                 {**self.launch,'version':True},{**self.launch,'pid':True},
                 {**self.launch,'processStartedAt':float('nan')},{**self.launch,'processStartedAt':112},
                 {**self.launch,'bootId':'not-uuid'},{**self.launch,'unexpected':'value'}]
        for launch in invalid:
            save_json(self.storage/'launch.json',launch)
            with self.subTest(launch=launch):
                with self.assertRaises((Error,ValueError)):self.observe()
        self.assertEqual(self.collector.lookups,[]);self.assertEqual(self.vm.reads,0)

    def test_assignment_avd_port_arguments_and_lease_bindings_are_required(self):
        invalid=[(self.folder/'assignment.json',{'fingerprint':'other'}),
                 (self.storage/'canaveral-owner.json',{'fingerprint':'other'}),
                 (self.storage/'avd-created.json',{'name':'another-avd'}),
                 (self.storage/'endpoint.json',{'port':5555}),
                 (self.storage/'endpoint.json',{'port':5556}),
                 (self.storage/'launch.json',{**self.launch,'leaseId':str(uuid.uuid4())}),
                 (self.storage/'launch.json',{**self.launch,'machineId':str(uuid.uuid4())})]
        for path,value in invalid:
            saved=path.read_bytes();save_json(path,value)
            with self.subTest(path=path.name):
                with self.assertRaises(Error):self.observe()
            path.write_bytes(saved)
        self.assertEqual(self.collector.lookups,[])
        lease_id=str(uuid.uuid4());self.machine['lease']={'id':lease_id};self.launch['leaseId']=lease_id
        save_json(self.storage/'launch.json',self.launch)
        self.assertEqual(self.observe(),[(self.vm,100.5,'simulators')])

    def test_wrong_executable_uid_birth_or_command_line_remains_unknown(self):
        for attribute,value in [('binary','/other/app'),('binary',str(self.root/'sdk-other/emulator/qemu/darwin-aarch64/qemu-system-aarch64')),
                                ('binary',str(self.root/'sdk/emulator/qemu/darwin-aarch64/qemu-system-x86_64')),
                                ('arguments',[self.vm.binary,'-avd','foreign']),('uid',os.getuid()+1),('born',100.6)]:
            original=getattr(self.vm,attribute);setattr(self.vm,attribute,value)
            with self.subTest(attribute=attribute,value=value):
                with self.assertRaises(Error):self.observe()
            setattr(self.vm,attribute,original)
        self.assertEqual(self.vm.reads,0)

    def test_pid_reuse_during_measurement_never_reads_foreign_usage(self):
        foreign=Process(99,110,'foreign',64*1048576)
        self.vm.after_read=lambda:self.collector.processes.__setitem__(99,foreign)
        agent=object.__new__(Agent);agent.lock=threading.RLock();agent.assignments=[self.machine]
        agent.context=Mock(return_value=(self.provider,self.machine['template'],self.folder))
        result=process_usage(self.collector,agent.owned_resource_processes)
        self.assertEqual(result['categories'][2],{'id':'simulators','cpuPercent':None,'memoryMiB':None,'processCount':None})
        self.assertEqual(foreign.reads,0);self.assertNotIn((99,100.5),_process_state.samples)

    def test_disappearing_root_or_descendant_is_unknown_until_observed_stopped(self):
        self.collector.processes.pop(99)
        with self.assertRaises(Error):self.observe()
        self.machine['observed']='stopped';self.assertEqual(self.observe(),[])
        self.collector.processes[99]=self.vm;self.machine['observed']='running'
        child=Process(100,101,'helper');self.vm.descendants=[child]
        with self.assertRaises(Error):self.observe()
        self.machine['observed']='stopped'
        with self.assertRaises(Error):self.observe()
        self.machine['observed']='running'
        self.vm.descendants=[];(self.storage/'launch.json').unlink()
        with self.assertRaises(OSError):self.observe()
        self.machine['observed']='stopped';self.assertEqual(self.observe(),[])

    def test_nonregular_and_linked_metadata_and_escaped_sdk_paths_are_refused(self):
        path=self.storage/'launch.json';saved=path.with_suffix('.saved');path.rename(saved)
        for kind in ('link','fifo','directory','oversized'):
            if kind=='link':path.symlink_to(saved)
            elif kind=='fifo':os.mkfifo(path)
            elif kind=='directory':path.mkdir()
            else:path.write_bytes(b'x'*65537)
            with self.subTest(kind=kind):
                with self.assertRaises((Error,OSError)):self.observe()
            if path.is_dir():path.rmdir()
            else:path.unlink()
        saved.rename(path)
        sdk=self.root/'sdk';sdk.mkdir();(self.root/'outside').mkdir();(sdk/'emulator').symlink_to(self.root/'outside',target_is_directory=True)
        with self.assertRaises(Error):self.observe()
        self.assertEqual(self.collector.lookups,[])

    def test_birth_capture_requires_unreaped_child_and_never_reaps_or_signals(self):
        process=Mock(pid=99);process.poll.return_value=None
        with patch('canaveral.process_groups.unreaped_child',return_value=False),patch.dict('sys.modules',{'psutil':self.collector}):
            self.assertIsNone(child_birth(process,100));self.assertEqual(self.collector.lookups,[])
        with patch('canaveral.process_groups.unreaped_child',return_value=True),patch.dict('sys.modules',{'psutil':self.collector}):
            self.assertEqual(child_birth(process,100),100.5)
            self.vm.born=200;self.assertIsNone(child_birth(process,100))
            self.vm.born=100.5;self.vm.uid+=1;self.assertIsNone(child_birth(process,100))
        process.wait.assert_not_called();process.kill.assert_not_called();process.terminate.assert_not_called()

    def test_new_launch_writes_bound_identity_once_and_retains_child_on_receipt_failure(self):
        (self.storage/'launch.json').unlink();(self.storage/'endpoint.json').unlink()
        process=Mock(pid=99)
        with patch.object(self.provider,'devices',return_value={}),patch.object(self.provider,'provision'),\
             patch('canaveral.providers.android.socket.socket'),patch('canaveral.providers.android.subprocess.Popen',return_value=process) as spawn,\
             patch('canaveral.providers.android.time.time',return_value=100),patch('canaveral.owned_usage.child_birth',return_value=100.5):
            self.assertEqual(self.provider.reconcile(self.machine,self.machine['template'],self.folder)['state'],'starting')
            launch=json.loads((self.storage/'launch.json').read_text())
            self.assertEqual(launch['processStartedAt'],100.5);self.assertEqual(launch['fingerprint'],self.launch['fingerprint'])
            self.assertEqual(launch['machineId'],self.machine['id']);self.assertEqual(launch['argv'],spawn.call_args.args[0])
            self.assertEqual(self.provider.reconcile(self.machine,self.machine['template'],self.folder)['state'],'starting')
            spawn.assert_called_once();self.assertIs(self.provider.processes[self.machine['id']],process)
            (self.storage/'launch.json').unlink();(self.storage/'endpoint.json').unlink()
            original=save_json
            def fail_receipt(path,value):
                if Path(path).name=='launch.json' and 'pid' in value:raise OSError('fixture receipt failure')
                original(path,value)
            with patch('canaveral.providers.android.save_json',side_effect=fail_receipt):
                with self.assertRaises(OSError):self.provider.reconcile(self.machine,self.machine['template'],self.folder)
            self.assertIs(self.provider.processes[self.machine['id']],process)
            self.assertNotIn('pid',json.loads((self.storage/'launch.json').read_text()))
