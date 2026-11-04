"""Revalidate an inspected AT-SPI path before one native action invocation."""
import json
import math
import sys

from canaveral.lease_clock import execution_monotonic

if __package__:
    from .inspect_linux import describe
else:
    from inspect_linux import describe

MAX_BYTES=6*1048576
FIELDS=('role','name','identifier','states','actions','bounds','properties')


def perform(request,api,clock=execution_monotonic):
    try:
        if not isinstance(request,dict) or set(request)!={'chain','action','startedAt','expiresAt'}:
            raise ValueError('Invalid action context')
        start,end=request['startedAt'],request['expiresAt']
        if any(type(n) not in (int,float) or not math.isfinite(n) for n in (start,end)) or start<0 or not 0<end-start<=15:
            raise ValueError('Invalid action lifetime')
        def fresh():
            if not start<=clock()<end:raise ValueError('Expired action context')
        fresh()
        chain=request['chain'];action=request['action']
        if not isinstance(chain,list) or not 1<=len(chain)<=31 or not isinstance(action,str):
            raise ValueError('Invalid action path')
        target=api.Registry.getDesktop(0);previous=[];seen=set()
        for index,node in enumerate(chain):
            fresh();path=node['path']
            if (not isinstance(path,list) or any(type(n) is not int or n<0 for n in path) or
                (path!=[] if index==0 else len(path)!=len(previous)+1 or path[:-1]!=previous)):
                raise ValueError('Incomplete parent path')
            if node['id'] in seen or node['parentId']!=(None if index==0 else chain[index-1]['id']):
                raise ValueError('Ambiguous parent path')
            seen.add(node['id'])
            if index:target=target.getChildAtIndex(path[-1])
            if describe(target)!={key:node[key] for key in FIELDS}:
                raise ValueError('Target context changed')
            previous=path
        if action not in chain[-1]['actions']:raise ValueError('Action was not inspected')
        interface=target.queryAction()
        matches=[i for i in range(interface.nActions) if interface.getName(i)==action]
        if len(matches)!=1:raise ValueError('Action is unavailable or ambiguous')
        fresh()
    except Exception:
        return 42 # Confirmed refusal before doAction.
    try:
        return 0 if interface.doAction(matches[0]) else 43
    except Exception:
        return 43 # Invocation started; effects may have occurred.


def main():
    try:
        raw=sys.stdin.buffer.read(MAX_BYTES+1)
        if len(raw)>MAX_BYTES:return 42
        request=json.loads(raw,parse_constant=lambda value:(_ for _ in ()).throw(ValueError('Nonfinite value')))
        import pyatspi
        return perform(request,pyatspi)
    except Exception:
        return 42


if __name__=='__main__':
    sys.exit(main())
