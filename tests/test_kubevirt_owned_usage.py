import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import Mock,patch

from canaveral.cluster_resources import collect,validate
from canaveral.cluster_ownership import unavailable
from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.kubevirt_ownership import annotations,begin,load,remember
from canaveral.model import Error,digest
from canaveral.providers.kubevirt import KubeVirt,manifest
from test_cluster_resources import inventory,metric
from test_devices import config
from test_orchestration import image,request


def reference(kind,name,uid,version='kubevirt.io/v1'):
    return {'kind':kind,'name':name,'uid':uid,'apiVersion':version,'controller':True}


class KubeVirtOwnedUsageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.provider=KubeVirt({'namespace':'guests'},self.root)
        self.machine={**request(),'template':image(),'desired':'running','observed':'running'}
        self.folder=self.root/'machines'/self.machine['id'];self.folder.mkdir(parents=True)
        fingerprint=digest({k:self.machine[k] for k in ('id','template','resources')})
        save_json(self.folder/'assignment.json',{'fingerprint':fingerprint})
        self.identity=begin(self.machine,'guests',self.folder)
        self.vm=manifest(self.machine,{**image(),'pvc':'base'},'guests')
        self.vm['metadata'].update(uid=str(uuid.uuid4()),annotations=annotations(self.identity))
        remember(self.machine,'guests',self.folder,self.vm)
        name=self.vm['metadata']['name'];vmi_uid=str(uuid.uuid4())
        self.vmi={'metadata':{'namespace':'guests','name':name,'uid':vmi_uid,
                             'ownerReferences':[reference('VirtualMachine',name,self.vm['metadata']['uid'])]},'status':{'phase':'Running'}}
        self.pod=inventory('launcher');self.pod['metadata'].update(uid=str(uuid.uuid4()),
            ownerReferences=[reference('VirtualMachineInstance',name,vmi_uid)])
        self.other=inventory('unrelated');self.other['metadata']['uid']=str(uuid.uuid4())
        self.vms=[self.vm];self.vmis=[self.vmi];self.pods=[self.pod,self.other]
        self.metrics=[metric('launcher'),metric('unrelated')];self.calls=[];self.hook=None
        self.provider.kubectl=self.kubectl

    def kubectl(self,*args,timeout=None,**kwargs):
        self.assertEqual(timeout,5);self.calls.append(args)
        if self.hook:
            value=self.hook(args)
            if value is not None:return value
        if '--raw' in args:return json.dumps({'items':self.metrics})
        values={'pods':self.pods,'virtualmachines.kubevirt.io':self.vms,'virtualmachineinstances.kubevirt.io':self.vmis,'resourcequotas':[]}
        return json.dumps({'items':values[args[1]]})

    def report(self,assignments=None):
        with patch('canaveral.cluster_resources.time.time',return_value=1793664060):
            result=collect(self.provider,[self.machine] if assignments is None else assignments)
        self.assertTrue(validate(result),result)
        return result

    def test_assigned_usage_is_separate_from_namespace_and_never_writes_receipts(self):
        before={p:p.read_bytes() for p in self.root.rglob('*.json')}
        result=self.report()
        self.assertEqual(result['metrics']['cpuCores'],.2)
        owned=result['canaveral'];self.assertEqual(owned['metrics']['cpuCores'],.1)
        self.assertEqual(owned['metrics']['memoryMiB'],64)
        self.assertEqual(owned['ownership'],{'status':'complete','assignedMachines':1,'verifiedMachines':1})
        self.assertEqual(before,{p:p.read_bytes() for p in self.root.rglob('*.json')})
        self.assertNotIn(self.machine['id'],json.dumps(result));self.assertNotIn(str(self.root),json.dumps(result))
        self.assertTrue(all(call[0]=='get' for call in self.calls))
        self.metrics=[metric('launcher')]
        result=self.report();self.assertEqual(result['metrics']['status'],'unavailable')
        self.assertEqual(result['canaveral']['metrics']['cpuCores'],.1)

    def test_migration_and_recursive_support_pods_count_actual_usage_once(self):
        migration=copy.deepcopy(self.pod);migration['metadata'].update(name='target',uid=str(uuid.uuid4()))
        support=inventory('hotplug');support['metadata'].update(uid=str(uuid.uuid4()),
            ownerReferences=[reference('Pod','target',migration['metadata']['uid'],'v1')])
        self.pods.extend([migration,support]);self.metrics.extend([metric('target'),metric('hotplug')])
        result=self.report()['canaveral']['metrics']
        self.assertEqual((result['podCount'],result['cpuCores'],result['memoryMiB']),(3,.3,192))
        self.assertEqual(self.machine['resources']['cpu'],2)
        self.metrics=[metric('launcher'),metric('unrelated')]
        result=self.report()['canaveral']['metrics']
        self.assertEqual(result['status'],'unavailable');self.assertNotIn('cpuCores',result)
        self.assertEqual(result['coverage'],{'status':'incomplete','activePods':3,'measuredPods':1})

    def test_labels_wrong_owner_uid_or_missing_controller_never_establish_ownership(self):
        bads=[[],[reference('VirtualMachineInstance',self.vmi['metadata']['name'],str(uuid.uuid4()))],
              [{**self.pod['metadata']['ownerReferences'][0],'controller':False}],
              [*self.pod['metadata']['ownerReferences'],reference('Pod','another','uid','v1')]]
        for refs in bads:
            self.pod['metadata'].update(labels={'canaveral.io/machine':self.machine['id']},ownerReferences=refs)
            with self.subTest(refs=refs):
                result=self.report();self.assertEqual(result['canaveral'],unavailable())
                self.assertEqual(result['metrics']['status'],'available')

    def test_legacy_missing_and_changed_assignment_proofs_are_not_adopted(self):
        owner=self.folder/'kubevirt-owner.json';saved=owner.read_bytes();owner.unlink()
        self.assertEqual(self.report()['canaveral'],unavailable());self.assertFalse(owner.exists())
        owner.write_bytes(saved)
        save_json(self.folder/'assignment.json',{'fingerprint':'another-assignment'})
        self.assertEqual(self.report()['canaveral'],unavailable())

    def test_vm_vmi_and_pod_incarnations_must_agree_and_change_during_sampling_is_unknown(self):
        original=copy.deepcopy(self.vm)
        self.vm['metadata']['uid']=str(uuid.uuid4())
        self.assertEqual(self.report()['canaveral'],unavailable())
        self.vm.clear();self.vm.update(original)
        self.vmi['metadata']['ownerReferences'][0]['uid']=str(uuid.uuid4())
        self.assertEqual(self.report()['canaveral'],unavailable())
        self.vmi['metadata']['ownerReferences'][0]['uid']=self.vm['metadata']['uid']
        reads=[]
        def churn(args):
            if args[1]=='pods':
                reads.append(1)
                if len(reads)==2:self.pod['metadata']['uid']=str(uuid.uuid4())
        self.hook=churn
        self.assertEqual(self.report()['canaveral'],unavailable())

    def test_metric_window_and_optional_uid_cannot_cross_a_pod_incarnation(self):
        for window in (None,'bad','-1s','0s','121s','2m1s'):
            self.metrics[0]['window']=window
            with self.subTest(window=window):
                self.assertEqual(self.report()['canaveral']['metrics']['status'],'unavailable')
        self.metrics[0]['window']='30s'
        self.pod['metadata']['creationTimestamp']='2026-11-03T00:00:45Z'
        self.assertEqual(self.report()['canaveral']['metrics']['status'],'unavailable')
        self.pod['metadata']['creationTimestamp']='2026-11-03T00:00:00Z'
        self.metrics[0]['metadata']['uid']=str(uuid.uuid4())
        self.assertEqual(self.report()['canaveral']['metrics']['status'],'unavailable')
        self.metrics[0]['metadata']['uid']=self.pod['metadata']['uid'];self.metrics[0]['window']='0m30000ms'
        self.assertEqual(self.report()['canaveral']['metrics']['status'],'available')

    def test_duplicate_uids_missing_launcher_or_incomplete_inventory_are_unknown(self):
        self.other['metadata']['uid']=self.pod['metadata']['uid']
        self.assertEqual(self.report()['canaveral'],unavailable())
        self.other['metadata']['uid']=str(uuid.uuid4());self.pods.remove(self.pod)
        self.assertEqual(self.report()['canaveral'],unavailable())
        self.pods.append(self.pod)
        self.hook=lambda args:json.dumps({'items':self.pods,'metadata':{'continue':'next-page'}}) if args[1]=='pods' else None
        result=self.report();self.assertEqual(result['canaveral'],unavailable());self.assertEqual(result['metrics']['status'],'unavailable')

    def test_stopped_or_empty_assignment_scope_is_zero_only_with_complete_reads(self):
        self.vmis=[];self.pods=[self.other];self.metrics=[metric('unrelated')];self.machine['observed']='stopped'
        self.assertEqual(self.report()['canaveral']['metrics']['podCount'],0)
        self.vms=[]
        self.assertEqual(self.report()['canaveral']['metrics']['cpuCores'],0)
        self.machine['observed']='running';self.assertEqual(self.report()['canaveral'],unavailable())
        self.assertEqual(self.report(assignments=[])['canaveral']['metrics']['cpuCores'],0)
        self.hook=lambda args:json.dumps({'items':None}) if '--raw' in args else None
        empty=self.report(assignments=[])['canaveral']
        self.assertEqual(empty['metrics']['status'],'unavailable');self.assertNotIn('cpuCores',empty['metrics'])

    def test_permission_failures_and_support_owner_cycles_do_not_leak_or_invent_zero(self):
        for denied in ('pods','virtualmachines.kubevirt.io','virtualmachineinstances.kubevirt.io'):
            def failure(args):
                if args[1]==denied:raise RuntimeError('PRIVATE cluster details')
            self.hook=failure
            with self.subTest(denied=denied):
                result=self.report();self.assertEqual(result['canaveral'],unavailable())
                self.assertNotIn('PRIVATE',json.dumps(result))
        self.hook=None
        self.pod['metadata']['ownerReferences']=[reference('Pod','launcher',self.pod['metadata']['uid'],'v1')]
        self.assertEqual(self.report()['canaveral'],unavailable())

    def test_controller_validation_retains_legacy_reports_and_rejects_contradictory_owned_totals(self):
        result=self.report();legacy=copy.deepcopy(result);legacy.pop('canaveral');self.assertTrue(validate(legacy))
        for mutation in ('partial','role','count','unknown-total','extra'):
            invalid=copy.deepcopy(result);owned=invalid['canaveral']
            if mutation=='partial':owned['ownership']['verifiedMachines']=0
            elif mutation=='role':owned['scope']='namespace'
            elif mutation=='count':owned['ownership']['assignedMachines']=True
            elif mutation=='unknown-total':owned['ownership']={'status':'unavailable'}
            else:owned['credential']='must-not-cross-report'
            with self.subTest(mutation=mutation):self.assertFalse(validate(invalid))

    def test_creation_receipt_recovers_lost_response_without_replaying_create(self):
        (self.folder/'kubevirt-create.json').unlink();(self.folder/'kubevirt-owner.json').unlink()
        current=[];created=[]
        def command(*args,**kwargs):
            if args[:2]==('get','virtualmachine'):return json.dumps(current[0]) if current else ''
            if args[0]=='create':
                value=json.loads(kwargs['data']);value['metadata']['uid']=str(uuid.uuid4());current.append(value);created.append(value)
                self.assertIn('-o',args);raise OSError('fixture lost creation response')
            if args[:2]==('get','virtualmachineinstance'):return json.dumps({'status':{'phase':'Running'}})
            self.fail(args)
        self.provider.kubectl=command
        with self.assertRaises(OSError):self.provider.reconcile(self.machine,{**image(),'pvc':'base'},self.folder)
        self.assertFalse((self.folder/'kubevirt-owner.json').exists())
        self.assertEqual(self.provider.reconcile(self.machine,{**image(),'pvc':'base'},self.folder)['state'],'running')
        self.assertEqual(len(created),1);self.assertEqual(load(self.machine,'guests',self.folder)['uid'],current[0]['metadata']['uid'])
        current[0]['metadata']['uid']=str(uuid.uuid4())
        with self.assertRaises(Error):self.provider.reconcile(self.machine,{**image(),'pvc':'base'},self.folder)

    def test_failed_create_or_foreign_same_name_object_is_never_retried_or_adopted(self):
        for name in ('kubevirt-create.json','kubevirt-owner.json'):(self.folder/name).unlink()
        creates=[];foreign=[]
        def command(*args,**kwargs):
            if args[:2]==('get','virtualmachine'):return json.dumps(foreign[0]) if foreign else ''
            if args[0]=='create':creates.append(1);raise Error('fixture creation uncertain')
            self.fail(args)
        self.provider.kubectl=command
        with self.assertRaises(Error):self.provider.reconcile(self.machine,{**image(),'pvc':'base'},self.folder)
        with self.assertRaises(Error):self.provider.reconcile(self.machine,{**image(),'pvc':'base'},self.folder)
        self.assertEqual(len(creates),1)
        foreign.append(copy.deepcopy(self.vm));foreign[0]['metadata']['annotations']={}
        with self.assertRaises(Error):self.provider.reconcile(self.machine,{**image(),'pvc':'base'},self.folder)
        self.assertFalse((self.folder/'kubevirt-owner.json').exists())

    def test_successful_create_records_uid_and_an_uncertain_retry_cannot_touch_preparation_secrets(self):
        for name in ('kubevirt-create.json','kubevirt-owner.json'):(self.folder/name).unlink()
        def command(*args,**kwargs):
            if args[:2]==('get','virtualmachine'):return ''
            if args[0]=='create':
                value=json.loads(kwargs['data']);value['metadata']['uid']=str(uuid.uuid4());return json.dumps(value)
            self.fail(args)
        self.provider.kubectl=Mock(side_effect=command)
        result=self.provider.reconcile(self.machine,{**image(),'pvc':'base'},self.folder)
        self.assertEqual(result['state'],'starting');self.assertTrue(load(self.machine,'guests',self.folder)['uid'])
        self.provider.kubectl.reset_mock()
        with self.assertRaises(Error):
            self.provider.reconcile(self.machine,{**image(),'pvc':'base','_userData':'private data','prepare':{'driver':'cloud-init'}},self.folder)
        self.provider.kubectl.assert_called_once_with('get','virtualmachine',self.provider.name(self.machine),'--ignore-not-found','-o','json')

    def test_absent_vm_does_not_hide_pending_creation_or_an_orphaned_vmi(self):
        machine={**self.machine,'desired':'stopped'}
        self.provider.kubectl=Mock(side_effect=['',json.dumps(self.vmi)])
        self.assertEqual(self.provider.reconcile(machine,image(),self.folder)['state'],'unknown')
        self.provider.kubectl=Mock(side_effect=['',''])
        self.assertEqual(self.provider.reconcile(machine,image(),self.folder)['state'],'stopped')
        (self.folder/'kubevirt-owner.json').unlink()
        self.provider.kubectl=Mock(return_value='')
        self.assertEqual(self.provider.reconcile(machine,image(),self.folder)['state'],'unknown')
        self.assertEqual(self.provider.kubectl.call_count,1)

    def test_nonregular_receipts_are_not_read_and_boolean_versions_are_rejected(self):
        import os
        path=self.folder/'kubevirt-owner.json';saved=path.with_suffix('.saved');path.rename(saved)
        for kind in ('link','fifo','directory','oversized'):
            if kind=='link':path.symlink_to(saved)
            elif kind=='fifo':os.mkfifo(path)
            elif kind=='directory':path.mkdir()
            else:path.write_bytes(b'x'*65537)
            with self.subTest(kind=kind):self.assertEqual(self.report()['canaveral'],unavailable())
            if path.is_dir():path.rmdir()
            else:path.unlink()
        saved.rename(path);identity=json.loads(path.read_text());identity['version']=True;save_json(path,identity)
        self.assertEqual(self.report()['canaveral'],unavailable())

    def test_background_worker_discards_owned_totals_after_assignment_change(self):
        agent=Agent(config(),'http://127.0.0.1:1',self.root/'agent')
        agent.assignments=[self.machine];agent.cluster_report=None
        entered=threading.Event();release=threading.Event();captured=[];result=self.report()
        def collect_delayed(assignments=None):
            captured.extend(assignments);entered.set();release.wait(2);return result
        agent.provider.resource_report=collect_delayed
        agent.check_requested.wait=Mock(side_effect=lambda _:agent.stopping.set())
        with patch('canaveral.host_health.inspect',return_value={'status':'passed','checkedAt':1,'checks':[]}):
            worker=threading.Thread(target=agent.check_environment);worker.start()
            try:
                self.assertTrue(entered.wait(1))
                with agent.lock:agent.assignments=[]
                release.set();worker.join(2);self.assertFalse(worker.is_alive())
                self.assertEqual(captured,[self.machine]);self.assertEqual(agent.cluster_report['canaveral'],unavailable())
                self.assertEqual(agent.cluster_report['metrics'],result['metrics'])
                self.assertEqual(result['canaveral']['metrics']['status'],'available')
            finally:release.set();agent.stopping.set();agent.check_requested.set();worker.join(2)
