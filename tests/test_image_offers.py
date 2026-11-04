import copy
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock
from canaveral.host import Agent
from canaveral.model import template, Error
from test_devices import config


class ImageOfferTests(unittest.TestCase):
    def test_retired_revision_remains_reconcilable_without_new_placement_offer(self):
        value=config(storage='/unused',androidSDK='/unused')
        old=copy.deepcopy(value['templates'][0])
        new=copy.deepcopy(old);new['revision']='2'
        value['templates']=[old,new]
        value['offerTemplateRevisions']=[new['id']+'@2:arm64']
        with tempfile.TemporaryDirectory() as root:
            agent=Agent(value,'http://127.0.0.1:8765',Path(root))
            self.assertEqual([t['revision'] for t in agent.offer['templates']],['2'])
            machine=dict(id=str(uuid.uuid4()),templateId=old['id'],template=template(old),resources=old['minimum'],desired='stopped')
            agent.provider.reconcile=Mock(return_value={'state':'stopped'})
            self.assertEqual(agent.reconcile(machine)['state'],'stopped')
            changed=copy.deepcopy(machine);changed['template']['revision']='uninstalled'
            with self.assertRaises(Error):agent.image(changed)
