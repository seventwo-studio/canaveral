import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from script.check_retention import MAX_BYTES, SECTIONS, compare, load, main, validate


def evidence():
    resources={'cpu':2,'memoryMiB':2048,'diskGiB':8}
    fingerprint=hashlib.sha256(b'fixture metadata').hexdigest()
    return {'schema':'canaveral-retention-v1','capturedAt':1000,'stable':{
        'machineAssignments':{'machine':{'hostId':'host','resources':resources,
            'template':{'id':'linux','revision':'1','arch':'arm64'},'desired':'running'}},
        'imageInventory':{'host/linux/1/arm64':{'hostId':'host','id':'linux','revision':'1','arch':'arm64'}},
        'nativeBootReceipts':{'machine':fingerprint},'hostBudgets':{'host':{'cpu':8,'memoryMiB':8192,'diskGiB':32}},
        'sharedBudgets':{},'reservations':{'host':dict(resources)},'configurationHashes':{'hostConfiguration':fingerprint}},
        'observations':{'consumerLeaseIds':[],'liveCleanupIntentIds':[]}}


class RetentionCheckTests(unittest.TestCase):
    def pair(self):
        before=evidence();after=copy.deepcopy(before);after['capturedAt']+=1
        return before,after

    def test_matching_snapshots_compare_by_identity_without_mutating_inputs(self):
        before,after=self.pair();after['stable']=dict(reversed(list(after['stable'].items())))
        saved=copy.deepcopy((before,after));result=compare(before,after)
        self.assertTrue(result['retentionMatches']);self.assertEqual(result['changedSections'],[])
        self.assertEqual((before,after),saved)

    def test_each_retained_section_change_fails_and_reports_only_its_name(self):
        for section in SECTIONS:
            with self.subTest(section=section):
                before,after=self.pair();items=after['stable'][section]
                if section=='sharedBudgets':items['pool']={'capacity':{'cpu':8,'memoryMiB':8192,'diskGiB':32},'hostIds':['host']}
                elif section in ('nativeBootReceipts','configurationHashes'):items[next(iter(items))]='a'*64
                elif section=='machineAssignments':items['machine']['desired']='stopped'
                elif section=='imageInventory':items[next(iter(items))]['revision']='2'
                else:items['host']['diskGiB']+=1
                result=compare(before,after)
                self.assertFalse(result['retentionMatches']);self.assertEqual(result['changedSections'],[section])
                self.assertNotIn('fixture',json.dumps(result))

    def test_same_count_replacement_and_addition_are_not_retention(self):
        for replacement in (False,True):
            before,after=self.pair();items=after['stable']['machineAssignments']
            items['other']=copy.deepcopy(items['machine'])
            if replacement:
                del items['machine'];after['stable']['nativeBootReceipts']={'other':'a'*64}
            result=compare(before,after)
            self.assertFalse(result['retentionMatches']);self.assertIn('machineAssignments',result['changedSections'])

    def test_missing_sections_empty_inventories_and_partial_assignments_are_not_proof(self):
        for section in SECTIONS:
            for empty in (False,True):
                if section=='sharedBudgets' and empty:continue
                with self.subTest(section=section,empty=empty):
                    value=evidence()
                    if empty:value['stable'][section]={}
                    else:del value['stable'][section]
                    with self.assertRaises(ValueError):validate(value)
        for value in ({'verified':True}, {}, {'schema':'canaveral-retention-v1'}):
            with self.assertRaises(ValueError):validate(value)
        value=evidence();value['stable']['machineAssignments']['machine']['template']={}
        with self.assertRaises(ValueError):validate(value)

    def test_leases_cleanup_and_non_later_capture_block_comparison(self):
        for field in ('consumerLeaseIds','liveCleanupIntentIds'):
            for which in (0,1):
                pair=self.pair();pair[which]['observations'][field]=['fixture-private-id']
                result=compare(*pair);self.assertFalse(result['retentionMatches'])
                self.assertNotIn('fixture-private-id',json.dumps(result))
        for stamp in (999,1000):
            before,after=self.pair();after['capturedAt']=stamp
            self.assertIn('after_not_later_than_before',compare(before,after)['reasonCodes'])

    def test_invalid_numbers_fingerprints_and_budget_coverage_are_refused(self):
        for amount in (True,-1,1.5,float('nan'),float('inf')):
            value=evidence();value['stable']['reservations']['host']['diskGiB']=amount
            with self.assertRaises(ValueError):validate(value)
        value=evidence();value['stable']['configurationHashes']['hostConfiguration']='missing'
        with self.assertRaises(ValueError):validate(value)
        value=evidence();value['stable']['reservations']['other']=value['stable']['reservations'].pop('host')
        with self.assertRaises(ValueError):validate(value)

    def test_cli_is_offline_read_only_and_has_distinct_match_change_and_invalid_exits(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);before,after=self.pair();paths=[root/'before.json',root/'after.json']
            for path,value in zip(paths,(before,after)):path.write_text(json.dumps(value))
            original={path:path.read_bytes() for path in paths}
            with patch('socket.socket',side_effect=AssertionError('Network forbidden')),patch('sys.stdout',new_callable=io.StringIO) as output:
                self.assertEqual(main([str(path) for path in paths]),0)
                self.assertTrue(json.loads(output.getvalue())['retentionMatches'])
            self.assertEqual({path:path.read_bytes() for path in paths},original)
            after['stable']['machineAssignments']['machine']['desired']='stopped';paths[1].write_text(json.dumps(after))
            with patch('sys.stdout',new_callable=io.StringIO):self.assertEqual(main([str(path) for path in paths]),1)
            paths[1].write_text('{"fixture-private-key":')
            with patch('sys.stdout',new_callable=io.StringIO) as output:
                self.assertEqual(main([str(path) for path in paths]),2)
                self.assertNotIn('fixture-private-key',output.getvalue());self.assertNotIn(str(root),output.getvalue())

    def test_duplicate_fields_and_oversized_evidence_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'evidence.json';path.write_text('{"schema":"one","schema":"two"}')
            with self.assertRaises(ValueError):load(path)
            with path.open('wb') as output:output.truncate(MAX_BYTES+1)
            with self.assertRaises(ValueError):load(path)

    def test_controller_fixture_exports_match_and_a_real_ledger_change_is_detected(self):
        import secrets
        import uuid
        from canaveral.store import Store
        from test_orchestration import host_offer,request
        with tempfile.TemporaryDirectory() as folder:
            store=Store(Path(folder)/'fixture.db');host=str(uuid.uuid4())
            store.enroll({'id':host,'credential':secrets.token_urlsafe(32),'offer':host_offer()})
            machine=store.create(request())
            def snapshot(stamp):
                result=evidence();result['capturedAt']=stamp
                resources=store.host_resources(host);stable=result['stable']
                stable['machineAssignments']={row['id']:{key:row[key] for key in ('hostId','resources','template','desired')}
                    for row in store.machines()}
                stable['imageInventory']={host+'/'+row['id']+'/'+row['revision']+'/'+row['arch']:{'hostId':host,**row}
                    for row in resources['images']}
                stable['nativeBootReceipts']={machine['id']:'a'*64} # Explicit fake native receipt, never a process read.
                stable['hostBudgets']={host:resources['limits']};stable['reservations']={host:resources['reserved']}
                return result
            before=snapshot(1000);self.assertTrue(compare(before,snapshot(1001))['retentionMatches'])
            store.create(request())
            result=compare(before,snapshot(1002))
            self.assertFalse(result['retentionMatches'])
            self.assertEqual(result['changedSections'],['machineAssignments','reservations'])

    @unittest.skipIf(os.name=='nt','POSIX nonregular-file fixtures; Windows acceptance is separate.')
    def test_nonregular_evidence_is_refused_without_waiting(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);fifo=root/'fifo';os.mkfifo(fifo)
            link=root/'link';link.symlink_to(fifo)
            code='from script.check_retention import load\nimport sys\nfor path in sys.argv[1:]:\n try:load(path)\n except ValueError:pass\n else:raise AssertionError("Accepted nonregular evidence")'
            result=subprocess.run([sys.executable,'-c',code,str(fifo),str(link),str(root)],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
