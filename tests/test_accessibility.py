import copy
import time
import unittest
from unittest.mock import patch
from canaveral.accessibility import snapshot, Inspections
from canaveral.model import Error


class AccessibilityTests(unittest.TestCase):
    def test_android_preserves_native_identifiers_bounds_and_redacts_password(self):
        value=snapshot('android','<hierarchy><node class="android.widget.Button" text="Open" resource-id="example:id/open" content-desc="Open file" clickable="true" enabled="true" bounds="[10,20][110,60]"/><node class="android.widget.EditText" text="secret" password="true" bounds="[0,0][20,20]"/></hierarchy>')
        self.assertEqual(value['source'],'android-uiautomator')
        self.assertEqual(value['nodes'][0]['identifier'],'example:id/open')
        self.assertEqual(value['nodes'][0]['bounds'],dict(x=10,y=20,width=100,height=40))
        self.assertEqual(value['nodes'][1]['properties']['text'],'[redacted]')
        self.assertNotIn('secret',str(value))
        elapsed=[100];cache=Inspections(clock=lambda:elapsed[0]);cache.save('owned',value)
        args=dict(snapshotId=value['snapshotId'],nodeId='ax-1')
        self.assertEqual(cache.target('owned',args,copy.deepcopy(value)),dict(x=60,y=40))
        with self.assertRaises(Error):cache.target('other',args,value)
        changed=copy.deepcopy(value);changed['nodes'][0]['name']='Changed'
        with self.assertRaises(Error):cache.target('owned',args,changed)
        elapsed[0]+=15
        with self.assertRaises(Error):cache.target('owned',args,value)

    def test_ios_preserves_properties_and_parent_relationships(self):
        value=snapshot('ios',{'output':'[{"type":"Application","label":"Demo","children":[{"type":"Button","label":"Save","identifier":"save-button","frame":{"x":1,"y":2,"width":10,"height":20},"enabled":true}]}]'})
        self.assertEqual(value['coordinateSpace'],'screen-points')
        self.assertEqual(value['nodes'][1]['parentId'],'ax-1')
        self.assertEqual(value['nodes'][1]['identifier'],'save-button')
        self.assertEqual(value['nodes'][1]['properties']['enabled'],True)

    def tree(self):
        return snapshot('android','<hierarchy><node class="Window" text="Documents" bounds="[0,0][200,200]"><node class="Button" text="Delete" clickable="true" bounds="[10,20][110,60]"/><node class="Text" text="Unrelated" bounds="[0,100][10,110]"/></node></hierarchy>')

    def test_parent_context_change_cannot_reuse_an_identical_target(self):
        old=self.tree();cache=Inspections();cache.save('owned',old)
        args={'snapshotId':old['snapshotId'],'nodeId':'ax-2'}
        for field in ('name','identifier','bounds','properties'):
            changed=copy.deepcopy(old)
            changed['nodes'][0][field]={'other':'context'} if isinstance(changed['nodes'][0][field],dict) else 'Another window'
            with self.subTest(field=field):
                self.assertEqual(changed['nodes'][1],old['nodes'][1])
                with self.assertRaises(Error):cache.target('owned',args,changed)
        unrelated=copy.deepcopy(old);unrelated['nodes'][2]['name']='Other unrelated text'
        self.assertEqual(cache.target('owned',args,unrelated),{'x':60,'y':40})

    def test_clock_rollback_cannot_extend_snapshot_lifetime(self):
        old=self.tree();elapsed=[100];cache=Inspections(clock=lambda:elapsed[0]);cache.save('owned',old)
        args={'snapshotId':old['snapshotId'],'nodeId':'ax-2'}
        with patch('canaveral.accessibility.time.time',return_value=old['capturedAt']-3600):
            elapsed[0]=114.99;self.assertEqual(cache.target('owned',args,old),{'x':60,'y':40})
            elapsed[0]=115
            with self.assertRaises(Error):cache.target('owned',args,old)
        self.assertEqual(cache.records,{})

    def test_long_capture_and_clock_domain_rollback_are_rejected(self):
        for now,started in ((116,100),(99,100)):
            cache=Inspections(clock=lambda:now);old=self.tree();cache.save('owned',old,started=started)
            with self.assertRaises(Error):cache.get('owned',old['snapshotId'])

    def test_cached_snapshot_is_independent_of_returned_mutable_data(self):
        old=self.tree();cache=Inspections();cache.save('owned',old);original=copy.deepcopy(old)
        old['nodes'][1]['name']='Mutated caller data'
        saved=cache.get('owned',old['snapshotId']);self.assertEqual(saved,original)
        saved['nodes'].clear();self.assertEqual(cache.get('owned',old['snapshotId']),original)

    def test_changed_coordinate_space_cycles_or_missing_context_refuse_input(self):
        old=self.tree();cache=Inspections();cache.save('owned',old);args={'snapshotId':old['snapshotId'],'nodeId':'ax-2'}
        for kind in ('space','source','cycle','missing','duplicate'):
            changed=copy.deepcopy(old)
            if kind=='space':changed['coordinateSpace']='screen-points'
            elif kind=='source':changed['source']='ios-accessibility'
            elif kind=='cycle':changed['nodes'][0]['parentId']='ax-2'
            elif kind=='missing':changed['nodes'].pop(0)
            else:changed['nodes'].append(changed['nodes'][0])
            with self.subTest(kind=kind):
                with self.assertRaises(Error):cache.target('owned',args,changed)

    def test_invalid_or_zero_area_geometry_never_becomes_a_tap(self):
        for bounds in ({'x':True,'y':0,'width':1,'height':1},{'x':0,'y':0,'width':0,'height':1},
                       {'x':float('inf'),'y':0,'width':1,'height':1},{'x':10**1000,'y':0,'width':1,'height':1}):
            old=snapshot('ios',[{'type':'Button','frame':bounds}]);cache=Inspections();cache.save('owned',old)
            with self.assertRaises(Error):cache.target('owned',{'snapshotId':old['snapshotId'],'nodeId':'ax-1'},old)
