"""Bounded native accessibility transfer and semantic snapshot validation."""
import math
import json
from importlib.resources import files

from .model import Error,identifier


SCHEMA='canaveral-accessibility-v1'
MAX_BYTES=6*1048576
MAX_NODES=2000


def snapshot_schema():
    return json.loads(files('canaveral').joinpath('schemas').joinpath('accessibility-snapshot.schema.json').read_text())


def finite(value):
    if type(value) not in (int,float):return False
    try:return math.isfinite(value)
    except OverflowError:return False


def validate_snapshot(value):
    if not isinstance(value,dict) or 'frame' in value:raise Error('Expected a native accessibility snapshot without image data.',409)
    try:identifier(value.get('snapshotId'))
    except Error as error:raise Error('Invalid accessibility snapshot identity.',409) from error
    captured=value.get('capturedAt')
    if not finite(captured) or captured<0:raise Error('Invalid accessibility capture time.',409)
    if not isinstance(value.get('source'),str) or not value['source'] or value.get('coordinateSpace') not in ('screen-pixels','screen-points'):
        raise Error('Accessibility source or coordinate space is missing.',409)
    if type(value.get('truncated')) is not bool or not isinstance(value.get('coverage'),str) or not value['coverage']:
        raise Error('Accessibility coverage must be explicit.',409)
    if 'unavailableNodes' in value and (type(value['unavailableNodes']) is not int or value['unavailableNodes']<0):raise Error('Invalid unavailable accessibility node count.',409)
    nodes=value.get('nodes')
    if not isinstance(nodes,list) or len(nodes)>MAX_NODES:raise Error('Accessibility nodes exceed the normalized snapshot envelope.',409)
    seen={}
    for node in nodes:
        if not isinstance(node,dict) or not isinstance(node.get('id'),str) or not node['id'] or node['id'] in seen:
            raise Error('Accessibility node identity is missing or duplicated.',409)
        parent=node.get('parentId')
        if 'parentId' not in node or (parent is not None and (not isinstance(parent,str) or parent not in seen)):
            raise Error('Accessibility parent must precede its child.',409)
        if type(node.get('depth')) is not int or not 0<=node['depth']<=30:raise Error('Invalid accessibility node depth.',409)
        if node['depth']!=(0 if parent is None else seen[parent]+1):raise Error('Accessibility depth differs from the parent relationship.',409)
        if any(not isinstance(node.get(key),str) for key in ('role','name','identifier')):raise Error('Accessibility node labels are malformed.',409)
        if not isinstance(node.get('states'),(dict,list)) or (isinstance(node['states'],list) and any(not isinstance(s,str) for s in node['states'])):
            raise Error('Accessibility states are malformed.',409)
        if not isinstance(node.get('actions'),list) or any(not isinstance(a,str) for a in node['actions']) or not isinstance(node.get('properties'),dict):
            raise Error('Accessibility actions or properties are malformed.',409)
        if 'bounds' not in node:raise Error('Accessibility bounds must be explicit or null.',409)
        bounds=node['bounds']
        if bounds is not None:
            if not isinstance(bounds,dict) or any(not finite(bounds.get(k)) for k in ('x','y','width','height')):
                raise Error('Accessibility bounds are malformed.',409)
            if bounds['width']<0 or bounds['height']<0:raise Error('Accessibility bounds have negative dimensions.',409)
        seen[node['id']]=node['depth']
    return value
