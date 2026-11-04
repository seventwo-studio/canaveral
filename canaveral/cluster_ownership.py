"""Read-only ownership graph for the runner's assigned KubeVirt VM pods."""
from pathlib import Path

from .kubevirt_ownership import load,matches_vm
from .model import Error,identifier,digest


def assignment_key(assignments):
    return digest(sorted([{'id':m['id'],'template':m.get('template'),'resources':m.get('resources'),
                           'leaseId':m.get('lease',{}).get('id'),'desired':m.get('desired'),'observed':m.get('observed')}
                          for m in assignments],key=lambda m:m['id']))


def unavailable():
    return {'scope':'assigned-vm-pods','ownership':{'status':'unavailable'},
            'metrics':{'status':'unavailable','coverage':{'status':'unavailable'}}}


def items(provider,resource):
    import json
    value=json.loads(provider.kubectl('get',resource,'-o','json',timeout=5))
    if not isinstance(value,dict) or value.get('metadata',{}).get('continue') or not isinstance(value.get('items'),list):
        raise Error('Cluster inventory is incomplete.')
    return value['items']


def index(values,namespace):
    names={};uids=set()
    for value in values:
        metadata=value['metadata'];name=metadata['name'];uid=metadata['uid']
        if (metadata['namespace']!=namespace or not isinstance(name,str) or not name
                or not isinstance(uid,str) or not uid or name in names or uid in uids):
            raise Error('Cluster object identity is ambiguous.')
        names[name]=value;uids.add(uid)
    return names


def controller(value):
    refs=[r for r in value.get('metadata',{}).get('ownerReferences',[]) if r.get('controller') is True]
    return refs[0] if len(refs)==1 else None


def metadata(value):
    meta=value['metadata']
    return {key:meta[key] for key in ('name','namespace','uid','creationTimestamp','labels','annotations','ownerReferences') if key in meta}


def snapshot(provider,assignments,pods,vms,vmis):
    namespace=provider.config['namespace'];machines={};proofs={};vm_state={}
    for machine in assignments:
        machine_id=identifier(machine['id'])
        if machine_id in machines:raise Error('Duplicate assigned cluster machine.')
        machines[machine_id]=machine
        proofs[machine_id]=load(machine,namespace,Path(provider.state)/'machines'/machine_id)
    vm_index=index(vms,namespace);vmi_index=index(vmis,namespace);pod_index=index(pods,namespace)
    assigned_names={proof['name']:mid for mid,proof in proofs.items()}
    for mid,proof in proofs.items():
        vm=vm_index.get(proof['name'])
        if vm is None:
            if machines[mid].get('observed')!='stopped':raise Error('Assigned VM is absent without a stopped observation.')
            vm_state[mid]=None
        else:
            if not matches_vm(vm,proof):raise Error('Assigned VM incarnation differs from its saved ownership.')
            vm_state[mid]=metadata(vm)
    vmi_owners={};vmi_state={}
    for name,vmi in vmi_index.items():
        ref=controller(vmi);label=vmi['metadata'].get('labels',{}).get('canaveral.io/machine')
        mid=assigned_names.get(name)
        if mid is None:
            if label in machines:raise Error('VMI label contradicts the assigned VM name.')
            continue
        proof=proofs[mid]
        if (vm_state[mid] is None or not ref or ref.get('kind')!='VirtualMachine' or ref.get('apiVersion')!='kubevirt.io/v1'
                or ref.get('uid')!=proof['uid'] or ref.get('name')!=proof['name'] or label not in (None,mid)):
            raise Error('VMI does not reference the pinned VM UID.')
        uid=vmi['metadata']['uid'];vmi_owners[uid]=(mid,name)
        vmi_state[uid]={'metadata':metadata(vmi),'phase':vmi.get('status',{}).get('phase')}
    pod_uids={pod['metadata']['uid']:pod for pod in pods};resolved={}
    def owner(pod,trail=frozenset()):
        uid=pod['metadata']['uid']
        if uid in resolved:return resolved[uid]
        if uid in trail:raise Error('Pod ownership cycle is ambiguous.')
        ref=controller(pod);mid=None
        label=pod['metadata'].get('labels',{}).get('canaveral.io/machine')
        if ref and ref.get('kind')=='VirtualMachineInstance' and ref.get('apiVersion')=='kubevirt.io/v1':
            match=vmi_owners.get(ref.get('uid'))
            if match:
                if ref.get('name')!=match[1]:raise Error('Pod VMI name differs from its UID.')
                mid=match[0]
            elif ref.get('name') in assigned_names:raise Error('Pod references an unverified VMI incarnation.')
        elif ref and ref.get('kind')=='Pod' and ref.get('apiVersion')=='v1':
            parent=pod_uids.get(ref.get('uid'))
            if parent is not None:
                if ref.get('name')!=parent['metadata']['name']:raise Error('Pod owner name differs from its UID.')
                mid=owner(parent,trail|{uid})
            elif any(v in vmi_owners for v in pod['metadata'].get('annotations',{}).values() if isinstance(v,str)):
                raise Error('Owned support pod has no verified parent.')
        if label in machines and mid!=label:raise Error('Pod label alone does not establish assigned ownership.')
        resolved[uid]=mid
        return mid
    selected=[];pod_state={};running={uid:0 for uid in vmi_owners}
    for name,pod in pod_index.items():
        mid=owner(pod)
        if mid is None:continue
        names=[c['name'] for c in pod['spec']['containers']]
        extra=[]
        for section in ('initContainerStatuses','ephemeralContainerStatuses'):
            extra.extend(c['name'] for c in pod.get('status',{}).get(section,[]) if 'running' in c.get('state',{}))
        phase=pod.get('status',{}).get('phase')
        pod_state[name]={'metadata':metadata(pod),'containers':sorted(names),'runningExtras':sorted(extra),'phase':phase}
        selected.append(pod)
        if phase not in ('Succeeded','Failed'):
            ref=controller(pod)
            if ref and ref.get('uid') in running:running[ref['uid']]+=1
    for uid,state in vmi_state.items():
        if state['phase'] in ('Running','Scheduled') and not running[uid]:
            raise Error('Active VMI has no verified active launcher pod.')
    return {'proofs':proofs,'vms':vm_state,'vmis':vmi_state,'pods':pod_state},selected
