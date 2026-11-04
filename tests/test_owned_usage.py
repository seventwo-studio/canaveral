import copy
import json
import os
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.host_health import process_usage,_process_state,sample
from canaveral.infrastructure import validate_sample
from canaveral.model import Error,digest
from canaveral.providers.apple import Apple


class MissingProcess(Exception):pass


class Process:
    def __init__(self,pid,born,name='python',rss=1048576):
        self.pid=pid;self.born=born;self.label=name;self.rss=rss;self.cpu=1;self.descendants=[]
        self.binary='/fixture/python';self.arguments=[];self.uid=os.getuid() if hasattr(os,'getuid') else 1000
        self.reads=0;self.after_read=None
    def create_time(self):return self.born
    def name(self):return self.label
    def exe(self):return self.binary
    def cmdline(self):return self.arguments
    def uids(self):return SimpleNamespace(real=self.uid)
    def children(self,recursive):return self.descendants
    def cpu_times(self):return SimpleNamespace(user=self.cpu,system=0)
    def memory_info(self):
        self.reads+=1
        if self.after_read:self.after_read()
        return SimpleNamespace(rss=self.rss)


class Collector:
    NoSuchProcess=MissingProcess
    def __init__(self,root,*others):self.root=root;self.processes={p.pid:p for p in (root,*others)};self.lookups=[]
    def Process(self,pid=None):
        self.lookups.append(pid)
        if pid is None:return self.root
        if pid not in self.processes:raise MissingProcess()
        return self.processes[pid]
    def cpu_count(self):return 4
    def cpu_percent(self,interval):return 25
    def virtual_memory(self):return SimpleNamespace(total=8*1073741824,available=4*1073741824)
    def disk_usage(self,path):return SimpleNamespace(total=100*1073741824,free=50*1073741824)


class OwnedUsageTests(unittest.TestCase):
    def setUp(self):_process_state.samples={}
    def test_owned_vm_is_measured_once_even_when_it_is_also_a_descendant(self):
        root=Process(1,50);vm=Process(99,100,'CanaveralVMRunner',4*1048576);root.descendants=[vm]
        foreign=Process(200,100,'CanaveralVMRunner',64*1048576);collector=Collector(root,vm,foreign)
        owned=lambda psutil:([(vm,100,'virtualMachines')],set())
        with patch('canaveral.host_health.time.monotonic',side_effect=[10,12]):
            first=process_usage(collector,owned);vm.cpu=3;second=process_usage(collector,owned)
        group=second['categories'][1]
        self.assertEqual((group['processCount'],group['memoryMiB'],group['cpuPercent']),(1,4,25))
        self.assertIsNone(first['categories'][1]['cpuPercent']);self.assertEqual(vm.reads,2)
        self.assertNotIn(200,collector.lookups);self.assertEqual(second['scope'],'runner-and-owned-processes')
        validate_sample({'scope':'host','domain':'fixture','sampledAt':1,'canaveral':second})

    def test_pid_reuse_during_measurement_is_unknown_without_foreign_rss(self):
        root=Process(1,50);vm=Process(99,100,'CanaveralVMRunner');foreign=Process(99,110,'Other app',64*1048576)
        collector=Collector(root,vm);vm.after_read=lambda:collector.processes.__setitem__(99,foreign)
        result=process_usage(collector,lambda api:([(vm,100,'virtualMachines')],set()))
        self.assertEqual(result['categories'][1],{'id':'virtualMachines','cpuPercent':None,'memoryMiB':None,'processCount':None})
        self.assertNotIn((99,100),_process_state.samples);self.assertEqual(foreign.reads,0)

    def test_unresolved_identity_is_not_zero_and_legacy_tree_scope_stays_valid(self):
        collector=Collector(Process(1,50));result=process_usage(collector,lambda api:([],{'virtualMachines'}))
        self.assertIsNone(result['categories'][1]['memoryMiB']);self.assertIsNone(result['categories'][1]['processCount'])
        legacy=process_usage(collector);self.assertEqual(legacy['scope'],'runner-process-tree')
        validate_sample({'scope':'host','domain':'fixture','sampledAt':1,'canaveral':legacy})

    def test_missing_runtime_collectors_keep_active_vm_and_simulator_categories_unknown(self):
        agent=object.__new__(Agent);agent.lock=threading.RLock()
        agent.assignments=[{'id':str(uuid.uuid4()),'template':{'os':system},'observed':'running'} for system in ('android','ios','windows')]
        agent.context=Mock(return_value=(SimpleNamespace(),{},None))
        collector=Collector(Process(1,50),Process(99,100,'unrelated-qemu',64*1048576))
        result=process_usage(collector,agent.owned_resource_processes)
        groups={g['id']:g for g in result['categories']}
        self.assertEqual(groups['services']['memoryMiB'],1)
        for category in ('virtualMachines','simulators'):
            self.assertEqual(groups[category],{'id':category,'cpuPercent':None,'memoryMiB':None,'processCount':None})
        self.assertNotIn(99,collector.lookups);self.assertEqual(result['scope'],'runner-and-owned-processes')
        validate_sample({'scope':'host','domain':'fixture','sampledAt':1,'canaveral':result})

    def test_stopped_missing_collector_and_verified_absence_remain_distinct_from_unknown(self):
        agent=object.__new__(Agent);agent.lock=threading.RLock()
        machine={'id':str(uuid.uuid4()),'template':{'os':'android'},'observed':'stopped'}
        agent.assignments=[machine];agent.context=Mock(return_value=(SimpleNamespace(),{},None))
        collector=Collector(Process(1,50))
        self.assertEqual(agent.owned_resource_processes(collector),([],set()))
        machine['observed']='unknown'
        self.assertEqual(agent.owned_resource_processes(collector),([],{'simulators'}))
        runtime=SimpleNamespace(resource_processes=Mock(return_value=[]))
        agent.context=Mock(return_value=(runtime,{},None))
        self.assertEqual(agent.owned_resource_processes(collector),([],set()))
        runtime.resource_processes.assert_called_once_with(machine,{},None,collector)

    def test_simulator_identity_lookup_failure_marks_only_its_native_category_unknown(self):
        agent=object.__new__(Agent);agent.lock=threading.RLock()
        agent.assignments=[{'id':str(uuid.uuid4()),'template':{'os':'ios'},'observed':'running'}]
        agent.context=Mock(side_effect=Error('Private provider details'))
        collector=Collector(Process(1,50))
        result=process_usage(collector,agent.owned_resource_processes)
        self.assertEqual(result['categories'][1]['memoryMiB'],0)
        self.assertIsNone(result['categories'][2]['memoryMiB'])
        self.assertNotIn('Private provider details',json.dumps(result))


@unittest.skipUnless(hasattr(os,'getuid'),'Apple ownership UID fixture requires POSIX.')
class AppleUsageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.provider=Apple({'provider':'apple','storage':str(self.root/'storage'),'runner':str(self.root/'CanaveralVMRunner')},self.root/'state')
        self.machine={'id':str(uuid.uuid4()),'template':{'id':'linux','revision':'1','arch':'arm64','os':'linux'},'resources':{'cpu':2,'memoryMiB':4096,'diskGiB':32}}
        self.folder=self.root/'assignment';self.folder.mkdir();self.storage=self.root/'storage'/self.machine['id'];self.native=self.storage/self.machine['id'].upper();self.native.mkdir(parents=True)
        fingerprint=digest({key:self.machine[key] for key in ('id','template','resources')})
        save_json(self.folder/'assignment.json',{'fingerprint':fingerprint});save_json(self.storage/'canaveral-owner.json',{'fingerprint':fingerprint})
        save_json(self.native/'machine.json',{'id':self.machine['id']})
        save_json(self.native/'runner-launch.json',{'attemptedAt':100})
        save_json(self.native/'status.json',{'pid':99,'updatedAt':101-978307200})
        self.vm=Process(99,100,'CanaveralVMRunner',4*1048576);self.vm.binary=self.provider.config['runner'];self.vm.arguments=[self.vm.binary,'run',str(self.native)]
        self.collector=Collector(Process(1,50),self.vm)
    def observe(self):return self.provider.resource_processes(self.machine,{},self.folder,self.collector)

    def test_detached_process_requires_existing_receipts_and_observation_writes_nothing(self):
        before={path: path.read_bytes() for path in self.root.rglob('*.json')}
        self.assertEqual(self.observe(),[(self.vm,100,'virtualMachines')])
        self.assertEqual(before,{path:path.read_bytes() for path in self.root.rglob('*.json')})
        self.assertFalse((self.native/'runtime.lock').exists())
        self.collector.processes.pop(99);self.assertEqual(self.observe(),[])

    def test_wrong_executable_arguments_owner_birth_or_boot_is_not_attributed(self):
        for field,value in (('binary','/other/app'),('arguments',[self.vm.binary,'run','/other/vm']),('uid',os.getuid()+1),('born',111)):
            original=getattr(self.vm,field);setattr(self.vm,field,value)
            with self.subTest(field=field):
                with self.assertRaises(Error):self.observe()
            setattr(self.vm,field,original)
        save_json(self.native/'status.json',{'pid':99,'updatedAt':90-978307200})
        with self.assertRaises(Error):self.observe()

    def test_assignment_native_identity_and_lease_mismatches_are_not_attributed(self):
        for path,value in ((self.folder/'assignment.json',{'fingerprint':'wrong'}),
                           (self.storage/'canaveral-owner.json',{'fingerprint':'wrong'}),
                           (self.native/'machine.json',{'id':str(uuid.uuid4())}),
                           (self.native/'machine.json',{'id':self.machine['id'],'executionLeaseID':str(uuid.uuid4())})):
            before=path.read_bytes();save_json(path,value)
            with self.subTest(path=path.name):
                with self.assertRaises(Error):self.observe()
            path.write_bytes(before)

    def test_agent_sampling_includes_verified_detached_vm_without_private_identity_fields(self):
        agent=object.__new__(Agent);agent.lock=threading.RLock();agent.assignments=[self.machine]
        agent.context=Mock(return_value=(self.provider,{},self.folder));_process_state.samples={}
        with patch.dict('sys.modules',{'psutil':self.collector}),patch('canaveral.host_health.platform.node',return_value='fixture'):
            report=sample({'provider':'macos','storage':str(self.root)},owned=agent.owned_resource_processes)
        self.assertEqual(report['canaveral']['scope'],'runner-and-owned-processes')
        self.assertEqual(report['canaveral']['categories'][1]['memoryMiB'],4)
        self.assertNotIn(str(self.root),json.dumps(report));self.assertNotIn('pid',json.dumps(report));validate_sample(report)
        self.vm.arguments=[self.vm.binary,'run','/foreign']
        processes,unknown=agent.owned_resource_processes(self.collector)
        self.assertEqual(processes,[]);self.assertEqual(unknown,{'virtualMachines'})

    def test_invalid_metadata_paths_and_oversized_receipts_are_not_observed(self):
        path=self.native/'status.json';saved=path.with_suffix('.retained');path.rename(saved)
        for kind in ('link','fifo','directory','oversized'):
            if kind=='link':path.symlink_to(saved)
            elif kind=='fifo':os.mkfifo(path)
            elif kind=='directory':path.mkdir()
            else:path.write_bytes(b'x'*65537)
            with self.subTest(kind=kind):
                with self.assertRaises((Error,OSError)):self.observe()
            if path.is_dir():path.rmdir()
            else:path.unlink()
        saved.rename(path);self.assertEqual(self.vm.reads,0)
        self.assertEqual(self.observe(),[(self.vm,100,'virtualMachines')])
