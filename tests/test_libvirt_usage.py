import copy
import ctypes
import json
import os
import threading
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.host_health import process_usage, _process_state
from canaveral.libvirt_usage import LinuxDomainCgroup, NativeResourceConnection, processes
from canaveral.libvirt_execution import prepare
from canaveral.libvirt_supervision import LibvirtLeaseBinding, SupervisorJournal, bind_domain_xml
from canaveral.model import Error
from canaveral.owned_removal import assignment_fingerprint
from canaveral.providers.libvirt import Libvirt
from test_libvirt_supervision import FakeCLibrary, Function
from test_libvirt_execution import ExecutionFixture


class Process:
    def __init__(self, pid, executable, argv, birth=1000, rss=1048576):
        self.pid=pid; self.executable=str(executable); self.argv=argv; self.birth=birth; self.rss=rss; self.cpu=1
    def create_time(self): return self.birth
    def exe(self): return self.executable
    def cmdline(self): return self.argv
    def cpu_times(self): return SimpleNamespace(user=self.cpu, system=0)
    def memory_info(self): return SimpleNamespace(rss=self.rss)
    def name(self): return Path(self.executable).name
    def children(self, recursive=False): return []


class LibvirtUsageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve(); self.folder=self.root/'assignment'; self.folder.mkdir(mode=0o700)
        self.machine={'id':str(uuid.uuid4()),'desired':'running','observed':'running',
            'template':{'id':'linux','os':'linux'},'resources':{'cpu':2,'memoryMiB':512,'diskGiB':4}}
        self.provider=Libvirt({'storage':str(self.root/'disks'),'uri':'qemu:///session'},self.root/'runtime')
        self.storage=self.root/'disks'/self.machine['id']; self.storage.mkdir(parents=True)
        self.disk=self.storage/'disk.qcow2'; self.disk.write_bytes(b'private fixture disk')
        fingerprint=assignment_fingerprint(self.machine)
        save_json(self.folder/'assignment.json',{'fingerprint':fingerprint})
        save_json(self.storage/'canaveral-owner.json',{'fingerprint':fingerprint})
        self.emulator=self.root/'qemu-system-x86_64'; self.emulator.write_bytes(b'never executed')
        name=self.provider.name(self.machine); native_id=7
        self.xml=f'<domain><name>{name}</name><uuid>{self.machine["id"]}</uuid><devices><emulator>{self.emulator}</emulator><disk type="file" device="disk"><source file="{self.disk}"/></disk></devices></domain>'
        self.snapshot={'xml':self.xml,'active':True,'id':native_id,'threads':[301,302]}
        self.connection=Mock(); self.connection.snapshot.side_effect=lambda:copy.deepcopy(self.snapshot)
        self.factory=Mock(return_value=self.connection)
        self.proc=self.root/'proc'; self.cg=self.root/'cgroup'; self.cg.mkdir(); (self.proc/'self').mkdir(parents=True)
        (self.proc/'self'/'mountinfo').write_text(f'1 0 0:1 / {self.cg} rw - cgroup2 cgroup rw\n')
        # Libvirt truncates guest names in systemd units; native QMP identity
        # anchors this scope independently of that shared prefix.
        unit='machine-'+('qemu-7-'+name[:19]).replace('-',r'\x2d')+'.scope'
        self.domain='/machine.slice/'+unit
        self.group=self.cg/'machine.slice'/unit
        for relative,kind,pids in (('', 'domain', ''),('libvirt','domain threaded','101\n101\n'),
                ('libvirt/emulator','threaded',None),('libvirt/vcpu0','threaded',None),('swtpm','domain','202\n')):
            path=self.group/relative; path.mkdir(parents=True,exist_ok=True)
            (path/'cgroup.type').write_text(kind+'\n')
            if pids is not None:(path/'cgroup.procs').write_text(pids)
        self.membership(101,self.domain+'/libvirt/emulator'); self.membership(202,self.domain+'/swtpm')
        for tid in (301,302):
            (self.proc/str(tid)).mkdir(); (self.proc/str(tid)/'status').write_text('Tgid:\t101\n')
        self.native={101:Process(101,self.emulator,['qemu','-uuid',self.machine['id']]),
            202:Process(202,'swtpm',['swtpm'],birth=1001,rss=2097152),
            999:Process(999,'runner',['runner'],birth=999)}
        self.psutil=SimpleNamespace(Process=lambda pid=None:self.native[999 if pid is None else pid],cpu_count=lambda:4)
        fixture=self
        class Kernel(LinuxDomainCgroup):
            def __init__(self): self.proc=fixture.proc; self.root=fixture.cg
        self.kernel=Kernel; self.boot=str(uuid.uuid4()); _process_state.samples={}

    def membership(self,pid,path):
        folder=self.proc/str(pid); folder.mkdir(exist_ok=True)
        (folder/'cgroup').write_text('0::'+path+'\n')

    def collect(self):
        return processes(self.provider,self.machine,{},self.folder,self.psutil,
            connection_factory=self.factory,kernel_factory=self.kernel,host_boot=lambda:self.boot)

    def test_owned_daemon_qemu_and_tpm_helper_in_same_scope_count_once(self):
        result=self.collect(); self.assertEqual([p.pid for p,_,_ in result],[101,202])
        self.native[999].children=lambda recursive=True:[self.native[101],self.native[202]]
        with patch('canaveral.host_health.time.monotonic',side_effect=[10,12]):
            first=process_usage(self.psutil,lambda _:(result,set()))
            self.native[101].cpu+=2; self.native[202].cpu+=2
            second=process_usage(self.psutil,lambda _:(self.collect(),set()))
        vm=next(v for v in second['categories'] if v['id']=='virtualMachines')
        self.assertEqual(vm['processCount'],2); self.assertEqual(vm['memoryMiB'],3); self.assertEqual(vm['cpuPercent'],50)
        self.assertIsNone(next(v for v in first['categories'] if v['id']=='virtualMachines')['cpuPercent'])
        self.assertEqual(next(v for v in second['categories'] if v['id']=='services')['processCount'],1)
        self.connection.close.assert_called()
        self.assertEqual(self.disk.read_bytes(),b'private fixture disk')

    def test_sibling_domain_is_never_enumerated_or_charged(self):
        sibling=self.group.with_name('machine-qemu-other.scope'); sibling.mkdir()
        (sibling/'cgroup.type').write_text('domain'); (sibling/'cgroup.procs').write_text('303\n')
        self.assertEqual([p.pid for p,_,_ in self.collect()],[101,202])

    def test_non_systemd_scope_is_supported_with_exact_native_id_and_name(self):
        target=self.group.with_name('qemu-7-'+self.provider.name(self.machine)+'.libvirt-qemu')
        self.group.rename(target); self.domain='/machine.slice/'+target.name
        self.membership(101,self.domain+'/libvirt/emulator'); self.membership(202,self.domain+'/swtpm')
        self.assertEqual(len(self.collect()),2)

    def test_denied_or_missing_cgroup_metadata_never_becomes_zero(self):
        (self.group/'swtpm'/'cgroup.procs').unlink()
        with self.assertRaises(OSError): self.collect()
        self.connection.close.assert_called_once()

    def test_v1_partial_mount_and_ambiguous_mounts_are_unknown(self):
        mount=self.proc/'self'/'mountinfo'; original=mount.read_text()
        for changed in (original.replace('cgroup2','cgroup'),original.replace(' / ',' /hidden ',1),original+original):
            mount.write_text(changed)
            with self.assertRaises(Error): self.collect()
        mount.write_text(original)
        (self.proc/'101'/'cgroup').write_text('2:cpu:/machine.slice/unknown\n')
        with self.assertRaises(Error): self.collect()

    def test_foreign_assignment_domain_uuid_disk_or_primary_executable_are_refused(self):
        before=(self.folder/'assignment.json').read_bytes(); save_json(self.folder/'assignment.json',{'fingerprint':'foreign'})
        with self.assertRaises(Error): self.collect()
        (self.folder/'assignment.json').write_bytes(before)
        for xml in (self.xml.replace(self.machine['id'],str(uuid.uuid4())),self.xml.replace(str(self.disk),'/foreign/disk')):
            self.snapshot['xml']=xml
            with self.assertRaises(Error): self.collect()
        self.snapshot['xml']=self.xml; self.native[101].executable='/foreign/qemu'
        with self.assertRaises(Error): self.collect()

    def test_qmp_threads_cannot_identify_multiple_or_unrelated_processes(self):
        (self.proc/'302'/'status').write_text('Tgid:\t202\n')
        with self.assertRaises(Error): self.collect()
        (self.proc/'302'/'status').write_text('Tgid:\t101\n'); self.native[101].argv=['qemu','-uuid',str(uuid.uuid4())]
        with self.assertRaises(Error): self.collect()

    def test_wrong_scope_id_name_and_root_partition_are_never_accepted(self):
        for path in ('/machine.slice','/machine.slice/machine-qemu-8-cvm.scope/emulator',
                     '/machine.slice/machine-qemu-7-unrelated.scope/emulator'):
            self.membership(101,path)
            with self.assertRaises(Error): self.collect()

    def test_cgroup_links_and_invalid_thread_types_are_refused(self):
        foreign=self.root/'outside'; foreign.mkdir(); (self.group/'linked').symlink_to(foreign,target_is_directory=True)
        with self.assertRaises(Error): self.collect()
        (self.group/'linked').unlink(); (self.group/'cgroup.type').write_text('domain invalid')
        with self.assertRaises(Error): self.collect()

    def test_changed_native_observation_or_boot_invalidates_entire_collection(self):
        other={**self.snapshot,'id':8}
        self.connection.snapshot.side_effect=[copy.deepcopy(self.snapshot),other]
        with self.assertRaises(Error): self.collect()
        self.connection.snapshot.side_effect=lambda:copy.deepcopy(self.snapshot)
        born=self.native[101].create_time
        def changed():self.boot=str(uuid.uuid4());return born()
        self.native[101].create_time=changed
        with self.assertRaises(Error): self.collect()

    def test_member_pid_reuse_or_migration_after_collection_withholds_vm_metrics(self):
        for mutation in ('birth','membership'):
            result=self.collect()
            if mutation=='birth':self.native[202].birth+=1
            else:self.membership(202,'/unrelated')
            observation=process_usage(self.psutil,lambda _:(result,set()))
            vm=next(v for v in observation['categories'] if v['id']=='virtualMachines')
            self.assertIsNone(vm['memoryMiB']); self.assertIsNone(vm['processCount'])
            if mutation=='membership':self.membership(202,self.domain+'/swtpm')

    def test_failed_owned_helper_is_not_reclassified_as_runner_service(self):
        result=self.collect(); self.native[999].children=lambda recursive=True:[self.native[202]]
        self.membership(202,'/unrelated')
        observation=process_usage(self.psutil,lambda _:(result,set()))
        services=next(v for v in observation['categories'] if v['id']=='services')
        self.assertEqual(services['processCount'],1)

    def test_native_inactive_observation_is_zero_only_when_repeated_and_owned(self):
        self.snapshot.update(active=False,id=None,threads=[])
        self.assertEqual(self.collect(),[]); self.connection.snapshot.assert_called()
        self.snapshot['xml']=self.xml.replace(str(self.disk),'/foreign')
        with self.assertRaises(Error): self.collect()

    def test_native_close_failure_does_not_return_a_partial_sample(self):
        self.connection.close.side_effect=Error('fixture close unknown',409)
        with self.assertRaises(Error): self.collect()

    def test_inactive_tpm_helper_is_not_assumed_to_have_exited(self):
        self.snapshot.update(active=False,id=None,threads=[])
        self.snapshot['xml']=self.xml.replace('</devices>','<tpm><backend type="emulator"/></tpm></devices>')
        with self.assertRaises(Error):self.collect()

    def test_agent_collector_propagates_unknown_vm_metrics_without_private_details(self):
        actor=SimpleNamespace(lock=threading.Lock(),assignments=[self.machine],
            context=lambda _:(self.provider,{},self.folder))
        original=processes
        with patch('canaveral.libvirt_usage.processes',side_effect=lambda *args:original(*args,
                connection_factory=self.factory,kernel_factory=self.kernel,host_boot=lambda:self.boot)):
            rows,unavailable=Agent.owned_resource_processes(actor,self.psutil)
            self.assertEqual(len(rows),2);self.assertEqual(unavailable,set())
            (self.group/'swtpm'/'cgroup.procs').unlink()
            rows,unavailable=Agent.owned_resource_processes(actor,self.psutil)
        self.assertEqual(rows,[]);self.assertEqual(unavailable,{'virtualMachines'})

    def test_collector_does_not_write_runtime_receipts_or_take_supervisor_locks(self):
        before={p.relative_to(self.root):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch('canaveral.libvirt_supervision.SupervisorJournal',side_effect=AssertionError('Read only')):
            self.collect()
        after={p.relative_to(self.root):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before,after)

    def leased(self):
        self.machine['lease']={'id':str(uuid.uuid4())}
        fingerprint=assignment_fingerprint(self.machine)
        save_json(self.folder/'assignment.json',{'fingerprint':fingerprint,'leaseId':self.machine['lease']['id']})
        library=self.root/'deadline.so';library.write_bytes(b'not executable; never loaded')
        binding=LibvirtLeaseBinding(self.machine['id'],self.machine['lease']['id'],str(uuid.uuid4()),self.boot,fingerprint,str(self.disk))
        prepare(binding,self.folder,'qemu:///session',library)
        self.snapshot['xml']=bind_domain_xml(self.xml,binding)
        return binding

    def test_leased_attribution_reads_exact_boot_without_taking_runtime_locks(self):
        self.leased(); execution=SupervisorJournal(self.folder)
        try:
            with patch.object(SupervisorJournal,'__init__',side_effect=AssertionError('Sampler must not create or lock runtime records')):
                self.assertEqual(len(self.collect()),2)
        finally:execution.close()

    def test_lease_or_kernel_boot_mismatch_cannot_adopt_domain_usage(self):
        self.leased();original=self.machine['lease']['id'];self.machine['lease']['id']=str(uuid.uuid4())
        with self.assertRaises(Error):self.collect()
        self.machine['lease']['id']=original;self.boot=str(uuid.uuid4())
        with self.assertRaises(Error):self.collect()
        self.factory.assert_not_called()

    def test_new_member_during_counter_measurement_withholds_partial_vm_total(self):
        rows=self.collect()
        (self.group/'swtpm'/'cgroup.procs').write_text('202\n303\n')
        self.membership(303,self.domain+'/swtpm')
        value=process_usage(self.psutil,lambda _:(rows,set()))
        self.assertIsNone(next(v for v in value['categories'] if v['id']=='virtualMachines')['memoryMiB'])

    def test_missing_host_cpu_count_or_invalid_counters_are_unknown(self):
        self.psutil.cpu_count=lambda:None
        with patch('canaveral.host_health.time.monotonic',side_effect=[10,12]):
            process_usage(self.psutil,lambda _:(self.collect(),set()))
            self.native[101].cpu+=1
            value=process_usage(self.psutil,lambda _:(self.collect(),set()))
        vm=next(v for v in value['categories'] if v['id']=='virtualMachines')
        self.assertIsNone(vm['cpuPercent']); self.assertEqual(vm['memoryMiB'],3)
        self.native[101].cpu=float('nan')
        value=process_usage(self.psutil,lambda _:(self.collect(),set()))
        self.assertIsNone(next(v for v in value['categories'] if v['id']=='virtualMachines')['memoryMiB'])


class NativeResourceABITests(ExecutionFixture):
    def native(self, active=True):
        xml=f'<domain><uuid>{self.machine["id"]}</uuid></domain>'
        library=FakeCLibrary(self.binding,xml); library.active=int(active);library.state=1 if active else 5
        library.virDomainGetID=Function(lambda _:7)
        qemu=SimpleNamespace(reply={'return':[{'thread-id':301,'cpu-index':0},{'thread-id':302,'cpu-index':1}]})
        def query(domain,command,result,flags):
            self.assertEqual(command,b'{"execute":"query-cpus-fast"}');self.assertEqual(flags,0)
            data=json.dumps(qemu.reply).encode()+b'\0'
            pointer=library.libc.malloc(len(data));ctypes.memmove(pointer,data,len(data))
            ctypes.cast(result,ctypes.POINTER(ctypes.c_void_p))[0]=pointer
            return 0
        qemu.virDomainQemuMonitorCommand=Function(query)
        connection=NativeResourceConnection('qemu:///session',self.machine['id'],library,qemu)
        self.addCleanup(connection.close);return connection,library,qemu

    def test_fixed_read_only_query_copies_response_and_frees_domain_handle(self):
        connection,library,_=self.native()
        result=connection.snapshot();self.assertEqual(result['threads'],[301,302]);self.assertEqual(result['id'],7)
        self.assertEqual(library.events,['free']);connection.close();self.assertEqual(library.events[-1],'close')

    def test_inactive_domains_are_not_queried(self):
        connection,_,qemu=self.native(False)
        qemu.virDomainQemuMonitorCommand.body=lambda *_:self.fail('No monitor query for an inactive domain')
        self.assertFalse(connection.snapshot()['active'])

    def test_failed_query_and_wrong_domain_state_never_produce_pids(self):
        connection,library,qemu=self.native()
        qemu.virDomainQemuMonitorCommand.body=lambda *_:-1
        with self.assertRaises(Error):connection.snapshot()
        library.state=6
        with self.assertRaises(Error):connection.snapshot()
        self.assertEqual(library.events,['free','free'])

    def test_monitor_correlation_id_and_shared_host_thread_are_supported(self):
        connection,_,qemu=self.native()
        qemu.reply={'id':'libvirt-42','return':[{'thread-id':301,'cpu-index':0},{'thread-id':301,'cpu-index':1}]}
        self.assertEqual(connection.snapshot()['threads'],[301])

    def test_error_duplicate_cpu_or_invalid_thread_response_is_unknown(self):
        connection,library,qemu=self.native()
        for reply in ({'error':{'class':'Denied'}}, {'return':[{'thread-id':True,'cpu-index':0}]},
                      {'return':[{'thread-id':301,'cpu-index':0},{'thread-id':302,'cpu-index':0}]}, {'return':[]}):
            qemu.reply=reply
            with self.assertRaises(Error):connection.snapshot()
        self.assertEqual(library.events,['free']*4)
