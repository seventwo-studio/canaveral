import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.preparation import user_data
from canaveral.seed import ensure_seed


class CloneIdentityTests(unittest.TestCase):
    def test_clones_get_distinct_cloud_identity_and_mac_dhcp_seeds(self):
        seen=[]
        def build(argv,**kwargs):
            content=Path(argv[-1]);output=Path(argv[argv.index('-o')+1])
            seen.append({p.name:p.read_text() for p in content.iterdir()})
            output.write_bytes(bytes(32768))
        image={'os':'linux','prepare':{'driver':'cloud-init','commands':['true']},'cloneIdentity':'linux-cloud-init'}
        with tempfile.TemporaryDirectory() as directory,patch('canaveral.seed.platform.system',return_value='Darwin'),patch('canaveral.providers.base.run',side_effect=build):
            for _ in range(2):
                id=str(uuid.uuid4());machine={'id':id}
                data=user_data(image,machine,'https://controller','x'*43,notify=False)
                config=json.loads(data.split('\n',1)[1])
                self.assertIn(id.replace('-',''),config['bootcmd'][0][-1])
                self.assertIn('/'+id+'/complete',config['bootcmd'][0][-1])
                folder=Path(directory)/id;folder.mkdir()
                ensure_seed({**image,'_userData':data},machine,folder)
        self.assertNotEqual(seen[0]['meta-data'],seen[1]['meta-data'])
        first,second=[json.loads(s['network-config'])['ethernets']['canaveral'] for s in seen]
        self.assertNotEqual(first['match']['macaddress'],second['match']['macaddress'])
        self.assertEqual(first['dhcp-identifier'],'mac')

    def test_legacy_recipe_does_not_change_machine_identity(self):
        data=user_data({'os':'linux','prepare':{'driver':'cloud-init','commands':['true']}},{'id':str(uuid.uuid4())},'https://controller','x'*43,notify=False)
        self.assertNotIn('bootcmd',json.loads(data.split('\n',1)[1]))
