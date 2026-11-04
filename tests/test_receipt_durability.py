import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from canaveral.files import save_json


class ReceiptDurabilityTests(unittest.TestCase):
    @unittest.skipIf(os.name=='nt','POSIX directory durability check')
    def test_signal_and_operation_receipts_sync_the_published_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'receipt.json';original=os.fsync;seen=[]
            def sync(fd):
                is_directory=stat.S_ISDIR(os.fstat(fd).st_mode)
                if is_directory:self.assertEqual(json.loads(target.read_text()),{'started':True})
                seen.append(is_directory);original(fd)
            with patch('canaveral.files.os.fsync',side_effect=sync):save_json(target,{'started':True})
            self.assertEqual(seen,[False,True]);self.assertEqual(target.stat().st_mode&0o777,0o600)
