import copy
import json
import unittest
from pathlib import Path

from canaveral.accessibility import snapshot
from canaveral.inspection_protocol import snapshot_schema,validate_snapshot
from canaveral.model import Error

try:
    from jsonschema import Draft202012Validator,FormatChecker
except ImportError:Draft202012Validator=None


@unittest.skipUnless(Draft202012Validator,'Install the test extra for JSON Schema validation')
class InspectionSchemaTests(unittest.TestCase):
    def setUp(self):
        schema=snapshot_schema();Draft202012Validator.check_schema(schema)
        self.validator=Draft202012Validator(schema,format_checker=FormatChecker())
        self.android=snapshot('android','<hierarchy><node class="Button" text="Submit" clickable="true" bounds="[1,2][3,4]"/></hierarchy>')

    def test_android_ios_linux_shapes_preserve_provider_properties(self):
        ios=snapshot('ios',[{'AXType':'Button','AXLabel':'Submit','frame':{'x':1,'y':2,'width':3,'height':4}}])
        linux=copy.deepcopy(self.android);linux.update(source='linux-atspi',unavailableNodes=2)
        linux['nodes'][0]['states']=['enabled','focused'];linux['nodes'][0]['properties']['native-specific']='retained'
        for value in (self.android,ios,linux):
            self.validator.validate(value);self.assertIs(validate_snapshot(value),value)

    def test_invalid_geometry_missing_coverage_and_embedded_frame_are_rejected(self):
        for mutate in (lambda v:v.pop('coverage'),lambda v:v.update(frame={'data':'not allowed'}),
            lambda v:v['nodes'][0]['bounds'].update(width=-1),lambda v:v['nodes'][0].update(states='invalid')):
            value=copy.deepcopy(self.android);mutate(value)
            self.assertTrue(list(self.validator.iter_errors(value)))
            with self.assertRaises(Error):validate_snapshot(value)

    def test_sdk_semantic_checks_add_identity_and_topology_constraints(self):
        # JSON Schema checks document shape; flat-array references need semantic checks.
        value=copy.deepcopy(self.android);value['nodes'][0]['parentId']='missing'
        self.validator.validate(value)
        with self.assertRaises(Error):validate_snapshot(value)
        value=copy.deepcopy(self.android);value['nodes'][0]['depth']=1
        self.validator.validate(value)
        with self.assertRaises(Error):validate_snapshot(value)
