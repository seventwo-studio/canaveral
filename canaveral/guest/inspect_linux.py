"""AT-SPI worker, isolated so an unresponsive app cannot stall the guest API."""
import json
import sys
import time


def describe(accessible):
    import pyatspi
    role, name = accessible.getRoleName(), accessible.name or ''
    states = [str(s).replace('STATE_','').lower() for s in accessible.getState().getStates()]
    properties = dict(item.split(':',1) for item in accessible.getAttributes() if ':' in item)
    if 'password' not in role.lower() and 'protected' not in states:
        try:
            text=accessible.queryText()
            properties['text']=text.getText(0,min(text.characterCount,4096))
        except Exception: pass
        try:
            value=accessible.queryValue()
            properties['value']=value.currentValue
            properties['minimum']=value.minimumValue
            properties['maximum']=value.maximumValue
        except Exception: pass
    properties['description']=accessible.description or ''
    actions=[]
    try:
        iface=accessible.queryAction()
        actions=[iface.getName(i) for i in range(iface.nActions)]
    except (NotImplementedError, Exception): pass
    bounds=None
    try:
        rect=accessible.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        bounds=dict(x=rect.x,y=rect.y,width=rect.width,height=rect.height)
    except (NotImplementedError, Exception): pass
    return dict(role=role,name=name,identifier=properties.get('id',properties.get('accessible-id','')),states=states,actions=actions,bounds=bounds,properties=properties)


def capture():
    import pyatspi
    nodes, truncated, failures = [], False, 0
    deadline = time.monotonic()+3
    def walk(accessible, path, parent=None, depth=0):
        nonlocal truncated, failures
        if len(nodes)>=1500 or depth>25 or time.monotonic()>deadline:
            truncated=True
            return
        try:
            details=describe(accessible)
            ref='ax-'+str(len(nodes)+1)
            node=dict(id=ref,parentId=parent,depth=depth,path=path,**details)
            nodes.append(node)
            for i in range(min(accessible.childCount,1500)):
                if time.monotonic()>deadline: truncated=True;break
                child=accessible.getChildAtIndex(i)
                if child: walk(child,path+[i],ref,depth+1)
        except Exception: failures+=1
    walk(pyatspi.Registry.getDesktop(0),[])
    return dict(nodes=nodes,truncated=truncated,unavailableNodes=failures)


if __name__=='__main__':
    print(json.dumps(capture()))
