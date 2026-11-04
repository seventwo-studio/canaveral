"""Bounded native accessibility snapshots shared by simulator clients and agents."""
import hashlib
import copy
import json
import math
import re
import time
import uuid
import threading
import xml.etree.ElementTree as ET

from .model import Error
from .lease_clock import execution_monotonic


def snapshot(system, native):
    nodes, truncated = [], False
    def add(props, parent, depth):
        nonlocal truncated
        if len(nodes) >= 2000 or depth > 30:
            truncated = True
            return None
        reference = 'ax-' + str(len(nodes) + 1)
        if system == 'android':
            bounds = [int(n) for n in re.findall(r'-?\d+', props.get('bounds', ''))]
            bounds = dict(x=bounds[0], y=bounds[1], width=bounds[2]-bounds[0], height=bounds[3]-bounds[1]) if len(bounds) == 4 else None
            password = props.get('password') == 'true'
            node = dict(role=props.get('class', ''), name=props.get('content-desc') or ('' if password else props.get('text', '')),
                        identifier=props.get('resource-id', ''), bounds=bounds,
                        states={key: props[key] == 'true' for key in ('enabled','focused','focusable','selected','checked','checkable','clickable','scrollable','password') if key in props},
                        actions=['click'] if props.get('clickable') == 'true' else [])
            props = {**props, 'text': '[redacted]' if password else props.get('text', '')}
        else:
            frame = props.get('frame') or props.get('bounds')
            if isinstance(frame, dict) and isinstance(frame.get('origin'), dict):
                frame = {**frame['origin'], **frame.get('size', {})}
            node = dict(role=props.get('role') or props.get('type') or props.get('AXType','unknown'),
                        name=props.get('label') or props.get('AXLabel') or props.get('title') or '',
                        identifier=props.get('identifier') or props.get('AXIdentifier') or '', bounds=frame,
                        states={k: props[k] for k in ('enabled','focused','selected','isEnabled','isFocused') if k in props},
                        actions=['click'] if isinstance(frame, dict) and all(k in frame for k in ('x','y','width','height')) else [])
        nodes.append(dict(id=reference, parentId=parent, depth=depth, **node, properties=props))
        return reference
    if system == 'android':
        raw = native if isinstance(native, str) else native.get('output', '')
        # SDK output may include a status line before the XML declaration.
        start = raw.find('<hierarchy')
        if start < 0:
            raise Error('Android accessibility hierarchy unavailable.')
        root = ET.fromstring(raw[start:])
        def walk(element, parent=None, depth=0):
            for child in element:
                ref = add(dict(child.attrib), parent, depth)
                if ref is not None:
                    walk(child, ref, depth+1)
        walk(root)
    else:
        raw = native.get('output', native) if isinstance(native, dict) else native
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = [json.loads(line) for line in raw.splitlines() if line.strip()]
        def walk(value, parent=None, depth=0):
            if isinstance(value, list):
                for child in value: walk(child, parent, depth)
            elif isinstance(value, dict):
                children = value.get('children', value.get('AXChildren', []))
                ref = add({k:v for k,v in value.items() if k not in ('children','AXChildren')}, parent, depth)
                if ref is not None: walk(children, ref, depth+1)
        walk(raw)
    return dict(snapshotId=str(uuid.uuid4()), capturedAt=time.time(), source='android-uiautomator' if system=='android' else 'ios-accessibility',
                coordinateSpace='screen-pixels' if system=='android' else 'screen-points', nodes=nodes, truncated=truncated,
                coverage='Native accessibility only; custom-rendered or inaccessible controls may be absent.')


class Inspections:
    def __init__(self,clock=None):
        self.records = {};self.received={};self.clock=clock or execution_monotonic
        self.lock=threading.RLock()

    def save(self, machine, value, started=None):
        with self.lock:
            now=self.clock()
            keep={key for key,stamp in self.received.items() if 0<=now-stamp<15}
            self.records={key:record for key,record in self.records.items() if key in keep}
            self.received={key:stamp for key,stamp in self.received.items() if key in keep}
            key=(machine,value['snapshotId'])
            self.records[key]=copy.deepcopy({k:v for k,v in value.items() if k!='frame'})
            self.received[key]=now if started is None else started
        return value

    def get(self,machine,snapshot_id):
        with self.lock:
            key=(machine,snapshot_id);old=self.records.get(key);stamp=self.received.get(key)
            if old is None or stamp is None or not 0<=self.clock()-stamp<15:
                self.records.pop(key,None);self.received.pop(key,None)
                raise Error('Accessibility target is stale. Inspect again before acting.',409,code='input_rejected')
            return copy.deepcopy(old)

    def discard(self,machine,snapshot_id):
        with self.lock:
            self.records.pop((machine,snapshot_id),None);self.received.pop((machine,snapshot_id),None)

    def action_context(self,machine,snapshot_id):
        with self.lock:
            value=self.get(machine,snapshot_id);started=self.received[(machine,snapshot_id)]
            return value,{'startedAt':started,'expiresAt':started+15}

    @staticmethod
    def lineage(value,node_id):
        nodes={n['id']:n for n in value['nodes']};chain=[];seen=set()
        if len(nodes)!=len(value['nodes']):raise Error('Accessibility node identities are ambiguous.')
        while node_id is not None:
            if node_id in seen or node_id not in nodes:raise Error('Accessibility parent context is unavailable.')
            seen.add(node_id);node=nodes[node_id];chain.append(node);node_id=node['parentId']
        return chain

    def target(self, machine, args, current):
        old=self.get(machine,args['snapshotId'])
        chain=self.lineage(old,args['nodeId']);node=chain[0]
        if 'click' not in node['actions']:
            raise Error('This accessibility node does not expose a click target.')
        # Traversal IDs are snapshot-local. Compare the complete target before posting input.
        if (old['source']!=current['source'] or old['coordinateSpace']!=current['coordinateSpace'] or
            self.lineage(current,args['nodeId'])!=chain):
            raise Error('Accessibility target changed. Inspect again before acting.')
        bounds = node['bounds']
        try:
            usable=(isinstance(bounds,dict) and all(type(bounds.get(k)) in (int,float) and math.isfinite(bounds[k]) for k in ('x','y','width','height')) and
                    bounds['width']>0 and bounds['height']>0)
        except OverflowError:usable=False
        if not usable:
            raise Error('Accessibility target has no usable bounds.')
        return {'x': round(bounds['x']+bounds['width']/2), 'y': round(bounds['y']+bounds['height']/2)}


def native_inspector(provider,image):
    backend=getattr(provider,'access',None)
    systems=getattr(backend,'inspection_systems',None)
    if (isinstance(systems,frozenset) and image.get('os') in systems
            and callable(getattr(backend,'inspect',None))):return backend
    return None


def inspection_supported(provider,image):
    return image.get('os') in ('linux','android','ios') or native_inspector(provider,image) is not None


def inspect_provider(provider,machine,image,folder,include_frame=False):
    if image.get('mode')=='headless':raise Error('This headless guest has no native graphical accessibility service.',409,code='capability_unsupported')
    import threading
    if not hasattr(provider,'inspection_lock'):
        provider.inspection_lock=threading.RLock()
    with provider.inspection_lock:
        backend=native_inspector(provider,image)
        if backend is not None:
            return backend.inspect(machine,image,folder,include_frame=include_frame)
        if image['os']=='linux':
            return provider.control(machine,image,folder,{'action':'accessibility','arguments':{'includeFrame':include_frame}})
        if not hasattr(provider,'inspections'):
            provider.inspections=Inspections()
        started=provider.inspections.clock()
        request={'id':str(uuid.uuid4()),'action':'hierarchy','arguments':{}}
        value=snapshot(image['os'],provider.control(machine,image,folder,request))
        if include_frame:
            value['frame']=provider.control(machine,image,folder,{'id':request['id'],'action':'screenshot','arguments':{}})
        return provider.inspections.save(machine['id'],value,started=started)
