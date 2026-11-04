import copy
import json
import math
import pathlib
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from canaveral.accessibility import Inspections
from canaveral.guest.action_linux import perform
from canaveral.guest.inspect_linux import capture
from canaveral.guest_access import helper_files
from canaveral.lease_clock import execution_monotonic


class Accessible:
    def __init__(self,name,role='button',children=()):
        self.name=name;self.role=role;self.children=list(children);self.description='Description'
        self.attributes=['id:'+name];self.states=['STATE_ENABLED'];self.bounds={'x':0,'y':0,'width':10,'height':10}
        self.actions=['click'];self.calls=[];self.fail=False;self.posted=True;self.lookup=None
    def getRoleName(self):return self.role
    def getState(self):return SimpleNamespace(getStates=lambda:self.states)
    def getAttributes(self):return self.attributes
    def queryText(self):raise NotImplementedError
    def queryValue(self):raise NotImplementedError
    def queryComponent(self):return SimpleNamespace(getExtents=lambda space:SimpleNamespace(**self.bounds))
    def queryAction(self):
        if self.lookup:self.lookup()
        return SimpleNamespace(nActions=len(self.actions),getName=lambda i:self.actions[i],doAction=self.invoke)
    def invoke(self,index):
        self.calls.append(index)
        if self.fail:raise RuntimeError('Uncertain native failure')
        return self.posted
    @property
    def childCount(self):return len(self.children)
    def getChildAtIndex(self,index):return self.children[index]


class LinuxActionWorkerTests(unittest.TestCase):
    def setUp(self):
        self.button=Accessible('Delete');self.other=Accessible('Status','text')
        self.window=Accessible('Documents','window',[self.button,self.other])
        self.root=Accessible('Desktop','desktop',[self.window]);self.elapsed=[100]
        self.api=SimpleNamespace(DESKTOP_COORDS=0,Registry=SimpleNamespace(getDesktop=lambda index:self.root))
        self.modules=patch.dict(sys.modules,{'pyatspi':self.api});self.modules.start();self.addCleanup(self.modules.stop)
        tree=capture();target=next(n for n in tree['nodes'] if n['name']=='Delete')
        self.request={'chain':list(reversed(Inspections.lineage(tree,target['id']))),'action':'click','startedAt':100,'expiresAt':115}
    def run_action(self,request=None):return perform(request or self.request,self.api,clock=lambda:self.elapsed[0])

    def test_unchanged_context_invokes_exactly_once_and_unrelated_sibling_change_is_allowed(self):
        self.other.name='New status'
        self.assertEqual(self.run_action(),0);self.assertEqual(self.button.calls,[0])

    def test_parent_changes_reject_an_unchanged_target(self):
        for field,value in (('name','Other window'),('role','dialog'),('attributes',['id:replacement']),
                            ('description','Other document'),('states',[]),('bounds',{'x':1,'y':0,'width':10,'height':10})):
            before=getattr(self.window,field);setattr(self.window,field,value)
            with self.subTest(field=field):self.assertEqual(self.run_action(),42);self.assertEqual(self.button.calls,[])
            setattr(self.window,field,before)

    def test_target_change_and_ambiguous_action_refuse_before_invocation(self):
        self.button.name='Other target';self.assertEqual(self.run_action(),42)
        self.button.name='Delete';self.button.actions=['click','click'];self.assertEqual(self.run_action(),42)
        self.assertEqual(self.button.calls,[])

    def test_expiry_during_native_resolution_is_checked_again_before_do_action(self):
        lookups=[]
        def slow_interface():
            lookups.append(True)
            if len(lookups)==2:self.elapsed[0]=115
        self.button.lookup=slow_interface
        self.assertEqual(self.run_action(),42);self.assertEqual(self.button.calls,[])
        self.assertEqual(len(lookups),2)

    def test_expiry_or_clock_rollback_before_resolution_never_invokes(self):
        for value in (99,115,116):
            self.elapsed[0]=value;self.assertEqual(self.run_action(),42)
        self.assertEqual(self.button.calls,[])

    def test_incomplete_parent_paths_and_invalid_lifetimes_are_refused(self):
        for kind in ('missing-root','negative-index','bool-index','parent','cycle','nan','long-lifetime'):
            request=copy.deepcopy(self.request)
            if kind=='missing-root':request['chain'].pop(0)
            elif kind=='negative-index':request['chain'][1]['path']=[-1]
            elif kind=='bool-index':request['chain'][1]['path']=[False]
            elif kind=='parent':request['chain'][-1]['parentId']='other'
            elif kind=='cycle':request['chain'][-1]['id']=request['chain'][0]['id']
            elif kind=='nan':request['expiresAt']=float('nan')
            else:request['expiresAt']=116
            with self.subTest(kind=kind):self.assertEqual(self.run_action(request),42)
        self.assertEqual(self.button.calls,[])

    def test_false_or_exception_after_invocation_keeps_unknown_outcome(self):
        self.button.posted=False;self.assertEqual(self.run_action(),43)
        self.button.fail=True;self.assertEqual(self.run_action(),43)
        self.assertEqual(self.button.calls,[0,0])

    def test_guest_control_passes_original_context_through_stdin_and_keeps_refusal_distinct(self):
        from canaveral.guest import server as guest
        tree={**capture(),'snapshotId':'fixture','capturedAt':1}
        cache=Inspections(clock=lambda:self.elapsed[0]);cache.save('guest',tree)
        args={'snapshotId':'fixture','nodeId':self.request['chain'][-1]['id'],'nativeAction':'click'}
        calls=[]
        def invoke(argv,*,input,timeout,capture_output):
            self.assertTrue(argv[-1].endswith('action_linux.py'));self.assertEqual(len(argv),2)
            self.assertEqual(timeout,5);self.assertTrue(capture_output)
            request=json.loads(input);calls.append(request)
            self.assertEqual((request['startedAt'],request['expiresAt']),(100,115))
            self.assertEqual(request['chain'],self.request['chain'])
            return SimpleNamespace(returncode=self.run_action(request))
        with patch.object(guest,'INSPECTIONS',cache),patch.object(guest.subprocess,'run',side_effect=invoke):
            self.assertEqual(guest.control('accessibility-action',args),{'posted':True})
            self.assertEqual(cache.records,{})
            cache.save('guest',tree);self.window.name='Changed parent'
            from canaveral.model import Error
            with self.assertRaises(Error) as failure:guest.control('accessibility-action',args)
            self.assertEqual(failure.exception.code,'input_rejected')
        self.assertEqual(len(calls),2);self.assertEqual(self.button.calls,[0])

    def test_generated_worker_reads_stdin_and_optimized_python_cannot_bypass_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            for item in helper_files():
                target=root/pathlib.PurePosixPath(item['path']).relative_to('/opt/canaveral')
                target.parent.mkdir(parents=True,exist_ok=True);target.write_text(item['content'])
            (root/'canaveral/__init__.py').write_text('')
            # A stub module only; no DBus, native accessibility service or guest.
            source='''from types import SimpleNamespace
import json
from pathlib import Path
DESKTOP_COORDS=0
DATA=json.loads(Path(__file__).with_name('tree.json').read_text())
class Node:
 def __init__(self,index):self.data=DATA[index];self.index=index
 @property
 def name(self):return self.data['name']
 @property
 def description(self):return self.data['properties']['description']
 def getRoleName(self):return self.data['role']
 def getState(self):return SimpleNamespace(getStates=lambda:['STATE_'+s.upper() for s in self.data['states']])
 def getAttributes(self):return [k+':'+v for k,v in self.data['properties'].items() if k!='description']
 def queryComponent(self):return SimpleNamespace(getExtents=lambda space:SimpleNamespace(**self.data['bounds']))
 def queryText(self):raise NotImplementedError
 def queryValue(self):raise NotImplementedError
 def queryAction(self):return SimpleNamespace(nActions=len(self.data['actions']),getName=lambda i:self.data['actions'][i],doAction=self.invoke)
 def getChildAtIndex(self,index):
  if index!=0:raise IndexError
  return Node(self.index+1)
 def invoke(self,index):Path(__file__).with_name('posted').write_text('once');return True
Registry=SimpleNamespace(getDesktop=lambda index:Node(0))
'''
            (root/'pyatspi.py').write_text(source)
            data=copy.deepcopy(self.request['chain']);(root/'tree.json').write_text(json.dumps(data))
            for changed in (False,True):
                # Whole seconds keep this maximum-length fixture exactly within 15s.
                # Fractional start + 15 can round to a span slightly above 15.
                request=copy.deepcopy(self.request);now=math.floor(execution_monotonic());request.update(startedAt=now,expiresAt=now+15)
                if changed:data[1]['name']='Replaced parent'
                (root/'tree.json').write_text(json.dumps(data));(root/'posted').unlink(missing_ok=True)
                result=subprocess.run([sys.executable,'-O',str(root/'action_linux.py')],input=json.dumps(request).encode(),capture_output=True,timeout=5)
                self.assertEqual(result.returncode,42 if changed else 0,result.stderr)
                self.assertEqual((root/'posted').exists(),not changed)
            result=subprocess.run([sys.executable,str(root/'action_linux.py')],input=b'{invalid',capture_output=True,timeout=5)
            self.assertEqual(result.returncode,42)
