import contextlib
import io
import json
import tempfile
import unittest
import uuid
from pathlib import Path

from canaveral.image_library import ImageLibrary,checksum
from canaveral.model import Error
from canaveral.store import Store
from test_orchestration import host_offer,request
import secrets


class ImageLibraryTests(unittest.TestCase):
    def metadata(self,**extra):
        return {'id':str(uuid.uuid4()),'name':'Ubuntu base','os':'linux','arch':'arm64','mode':'desktop','mediaType':'disk','format':'raw',
                'minimum':{'cpu':2,'memoryMiB':4096,'diskGiB':32},**extra}

    def test_stream_import_is_immutable_sparse_and_has_private_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            library=ImageLibrary(directory);metadata=self.metadata();payload=b'\0'*2097152
            result=library.import_stream(metadata,io.BytesIO(payload),len(payload),lambda:True)
            self.assertEqual(library.definitions(),[])
            library.acknowledge({result['id']:result['sha256']})
            definition=library.definitions()[0]
            self.assertEqual(checksum(definition['image']),result['sha256'])
            self.assertEqual(Path(definition['image']).stat().st_size,len(payload))
            self.assertNotIn(directory,json.dumps(result))
            self.assertEqual(library.import_stream(metadata,io.BytesIO(payload),len(payload),lambda:True),result)
            with self.assertRaises(Error):library.import_stream(metadata,io.BytesIO(b'x'*512),512,lambda:True)
            self.assertEqual(len(library.records()),1)

    def test_interrupted_revoked_and_wrong_media_imports_are_not_published(self):
        with tempfile.TemporaryDirectory() as directory:
            library=ImageLibrary(directory)
            with self.assertRaises(Error):library.import_stream(self.metadata(),io.BytesIO(b'x'*512),1024,lambda:True)
            with self.assertRaises(Error):library.import_stream(self.metadata(),io.BytesIO(b'x'*512),512,lambda:False)
            with self.assertRaises(Error):library.import_stream(self.metadata(mediaType='installer',format='iso'),io.BytesIO(b'x'*512),512,lambda:True)
            self.assertEqual(library.records(),[])
            self.assertEqual(list(library.root.glob('*.partial')),[])

    def test_provisioning_refuses_artifact_changed_after_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            library=ImageLibrary(directory);payload=b'original'*64
            result=library.import_stream(self.metadata(),io.BytesIO(payload),len(payload),lambda:True)
            library.acknowledge({result['id']:result['sha256']});image=library.definitions()[0]
            library.verify_definition(image);library.verify_definition(image)
            Path(image['image']).chmod(0o600)
            Path(image['image']).write_bytes(b'tampered'*64)
            with self.assertRaises(Error):library.verify_definition(image)

    def test_capture_publishes_only_after_fencing_and_has_a_restart_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);disk=root/'disk.raw';disk.write_bytes(b'disk'*128)
            source_id=str(uuid.uuid4());task={'id':str(uuid.uuid4()),'machineId':source_id,'name':'Configured Ubuntu',
                'machine':{'id':source_id,'desired':'stopped','observed':'stopped','resources':{'cpu':2,'memoryMiB':4096,'diskGiB':32}}}
            library=ImageLibrary(root/'agent')
            class Runtime:
                calls=0
                @contextlib.contextmanager
                def capture_source(self,*args):
                    self.calls+=1;yield disk,'raw'
            runtime=Runtime();image={'os':'linux','arch':'arm64','mode':'desktop'}
            result=library.capture(task,runtime,image,None)
            self.assertEqual(result['state'],'succeeded')
            self.assertEqual(result['result']['sourceMachineId'],source_id)
            self.assertEqual(library.capture(task,runtime,image,None),result)
            self.assertEqual(runtime.calls,1)
            library.acknowledge({result['result']['id']:result['result']['sha256']})
            self.assertEqual(len(library.definitions()),1)


class ImageReservationTests(unittest.TestCase):
    def test_capture_reserves_storage_and_blocks_source_restart_until_confirmed(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(Path(directory)/'db');host=str(uuid.uuid4());token=secrets.token_urlsafe(32);offered=host_offer()
            store.enroll({'id':host,'credential':token,'offer':offered})
            machine=store.create(request(hostId=host))
            capture={'id':str(uuid.uuid4()),'machineId':machine['id'],'name':'Configured image'}
            with self.assertRaises(Error):store.create_image_capture(capture)
            store.desired(machine['id'],'stopped')
            store.heartbeat(host,token,{'offer':offered,'reports':{machine['id']:{'state':'stopped'}}})
            receipt=store.create_image_capture(capture)
            self.assertEqual(receipt['state'],'queued')
            self.assertEqual(store.hosts()[0]['reserved']['diskGiB'],21)
            with self.assertRaises(Error):store.desired(machine['id'],'running')
            response=store.heartbeat(host,token,{'offer':offered,'imageReports':{capture['id']:{'state':'failed','result':{'detail':'Fixture source rejected'}}}})
            self.assertEqual(store.hosts()[0]['reserved']['diskGiB'],10)
            self.assertEqual(store.desired(machine['id'],'running')['desired'],'running')
