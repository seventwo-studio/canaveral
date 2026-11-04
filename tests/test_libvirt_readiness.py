import copy
import hashlib
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from canaveral.host_health import inspect
from canaveral.infrastructure import validate_health
from canaveral.libvirt_readiness import deadline_artifact
from canaveral.model import Error


def synthetic_elf(machine=62):
    """Header/symbol fixture only; contains no executable deadline implementation."""
    data=bytearray(1024);data[:16]=b'\x7fELF\x02\x01\x01'+bytes(9)
    struct.pack_into('<HHIQQQIHHHHHH',data,16,3,machine,1,0,64,512,0,64,56,2,64,4,0)
    struct.pack_into('<IIQQQQQQ',data,64,1,5,0,0,0,len(data),len(data),4096)
    struct.pack_into('<IIQQQQQQ',data,120,2,4,240,240,240,16,16,8)
    names=b'\0canaveral_lease_deadline_install\0canaveral_lease_deadline_arm\0'
    data[256:256+len(names)]=names
    struct.pack_into('<IBBHQQ',data,384+24,1,0x12,0,1,176,16)
    struct.pack_into('<IBBHQQ',data,384+48,names.index(b'canaveral_lease_deadline_arm'),0x12,0,1,192,16)
    struct.pack_into('<IIQQQQIIQQ',data,512+64,0,1,6,176,176,64,0,0,16,0)
    struct.pack_into('<IIQQQQIIQQ',data,512+128,0,3,0,0,256,len(names),0,0,1,0)
    struct.pack_into('<IIQQQQIIQQ',data,512+192,0,11,0,0,384,72,2,1,8,24)
    return bytes(data)


class DeadlineReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.path=self.root/'private-deadline.so'
        self.path.write_bytes(synthetic_elf());self.path.chmod(0o600)

    def test_inspection_binds_owned_snapshot_and_exports_without_loading_code(self):
        with patch('ctypes.CDLL',side_effect=AssertionError('Never load the deadline shim during environment checks')):
            result=deadline_artifact(self.path,'amd64')
        self.assertEqual(result['sha256'],hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertEqual(result['exports'],['canaveral_lease_deadline_arm','canaveral_lease_deadline_install'])
        self.path.write_bytes(synthetic_elf(183));self.assertEqual(deadline_artifact(self.path,'arm64')['arch'],'arm64')

    def test_wrong_architecture_format_and_truncated_tables_are_rejected(self):
        original=self.path.read_bytes()
        for value in (b'not an ELF library',original[:40],original[:600],synthetic_elf(183)):
            self.path.write_bytes(value)
            with self.assertRaises(Error) as caught:deadline_artifact(self.path,'amd64')
            self.assertEqual(caught.exception.code,'lease_deadline_artifact_invalid')

    def test_missing_hidden_undefined_or_noncode_exports_are_not_ready(self):
        original=synthetic_elf()
        for mutation in ('name','hidden','undefined','section','address','zero-size'):
            value=bytearray(original)
            if mutation=='name':value[257]=ord('x')
            elif mutation=='hidden':value[384+24+5]=2
            elif mutation=='undefined':struct.pack_into('<H',value,384+24+6,0)
            elif mutation=='section':struct.pack_into('<H',value,384+24+6,2)
            elif mutation=='address':struct.pack_into('<Q',value,384+24+8,999999)
            else:struct.pack_into('<Q',value,384+24+16,0)
            self.path.write_bytes(value)
            with self.subTest(mutation=mutation),self.assertRaises(Error):deadline_artifact(self.path,'amd64')

    def test_bad_offsets_symbol_sizes_and_dynamic_segment_are_refused(self):
        for mutation in ('phoff','shoff','link','symbol-size','dynamic'):
            value=bytearray(synthetic_elf())
            if mutation=='phoff':struct.pack_into('<Q',value,32,2**63)
            elif mutation=='shoff':struct.pack_into('<Q',value,40,2**63)
            elif mutation=='link':struct.pack_into('<I',value,512+192+40,99999)
            elif mutation=='symbol-size':struct.pack_into('<Q',value,512+192+56,8)
            else:struct.pack_into('<I',value,120,1)
            self.path.write_bytes(value)
            with self.subTest(mutation=mutation),self.assertRaises(Error):deadline_artifact(self.path,'amd64')

    def test_public_writable_linked_and_special_artifacts_are_refused(self):
        self.path.chmod(0o666)
        with self.assertRaises(Error):deadline_artifact(self.path,'amd64')
        self.path.chmod(0o600);link=self.root/'alias.so';link.symlink_to(self.path)
        with self.assertRaises(Error):deadline_artifact(link,'amd64')
        link.unlink();os.link(self.path,link)
        with self.assertRaises(Error):deadline_artifact(self.path,'amd64')
        link.unlink()
        if hasattr(os,'mkfifo'):
            self.path.unlink();os.mkfifo(self.path)
            with self.assertRaises(Error):deadline_artifact(self.path,'amd64')

    def test_metadata_changed_during_snapshot_does_not_pass(self):
        from canaveral.libvirt_execution import library_digest
        calls=[]
        def mutate(fd):
            value=library_digest(fd);calls.append(value)
            if len(calls)==1:self.path.write_bytes(synthetic_elf(183))
            return value
        with patch('canaveral.libvirt_readiness.library_digest',side_effect=mutate):
            with self.assertRaises(Error):deadline_artifact(self.path,'amd64')

    def settings(self):
        return {'provider':'libvirt','storage':str(self.root/'storage'),'capacity':{'cpu':2,'memoryMiB':512,'diskGiB':4},
                'templates':[],'leaseDeadlineLibrary':str(self.path)}

    def report(self,settings):
        provider=SimpleNamespace(check=Mock())
        measured={'cpuCount':8,'memoryTotalMiB':16384,'diskFreeGiB':100}
        with patch('canaveral.host_health.sample',return_value=measured),patch('canaveral.host_health.platform.system',return_value='Linux'), \
             patch('canaveral.host_health.architecture',return_value='amd64'),patch('canaveral.host_health.shutil.which',return_value='/fixture/tool'), \
             patch('canaveral.host_health.subprocess.run',return_value=Mock(stdout=b'fixture 1.0')), \
             patch('ctypes.CDLL',side_effect=AssertionError('No shim loading')):
            value=inspect(settings,provider,self.root)
        validate_health(value)
        return value,provider

    def test_configured_artifact_is_separate_from_native_lease_acceptance(self):
        report,provider=self.report(self.settings());checks={v['id']:v for v in report['checks']}
        self.assertEqual(checks['libvirt-lease-artifact']['status'],'passed')
        self.assertTrue(report['capabilities']['libvirtLeaseArtifact'])
        self.assertEqual(checks['libvirt-lease-acceptance']['status'],'warning')
        self.assertEqual(report['status'],'warning');provider.check.assert_called_once()
        self.assertNotIn(str(self.path),json.dumps(report))

    def test_missing_artifact_warns_invalid_configuration_fails_without_backend_probe(self):
        settings=self.settings();settings.pop('leaseDeadlineLibrary')
        report,_=self.report(settings)
        self.assertFalse(report['capabilities']['libvirtLeaseArtifact'])
        self.assertEqual(next(v['status'] for v in report['checks'] if v['id']=='libvirt-lease-artifact'),'warning')
        settings=self.settings();self.path.write_bytes(b'PRIVATE-INVALID-ARTIFACT')
        report,provider=self.report(settings)
        self.assertEqual(report['status'],'failed');provider.check.assert_not_called()
        self.assertFalse(report['capabilities']['libvirtLeaseArtifact'])
        self.assertNotIn('PRIVATE-INVALID',json.dumps(report));self.assertNotIn(str(self.path),json.dumps(report))
