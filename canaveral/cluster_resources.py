"""Read-only namespace metrics; missing Kubernetes APIs are explicit unknowns."""
from decimal import Decimal, DecimalException
from datetime import datetime
import json
import re
import time


def timestamp(value):
    if not isinstance(value,str):raise ValueError('Missing metrics timestamp')
    parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None:raise ValueError('Unqualified metrics timestamp')
    return parsed.timestamp()


def pod_usage(provider,now,inventory=None,metrics=None,strict=False):
    unavailable={'status':'unavailable','coverage':{'status':'unavailable'}}
    try:
        if inventory is None:inventory=json.loads(provider.kubectl('get','pods','-o','json',timeout=5))['items']
        if not isinstance(inventory,list):raise ValueError('Invalid pod inventory')
        active={}
        for pod in inventory:
            if pod.get('status',{}).get('phase') in ('Succeeded','Failed'):continue
            name=pod['metadata']['name']
            if pod['metadata']['namespace']!=provider.config['namespace']:raise ValueError('Different namespace')
            if name in active:raise ValueError('Duplicate pod identity')
            names=[c['name'] for c in pod['spec']['containers']]
            if not names or len(set(names))!=len(names):raise ValueError('Invalid container inventory')
            expected=set(names)
            for section in ('initContainerStatuses','ephemeralContainerStatuses'):
                expected.update(c['name'] for c in pod.get('status',{}).get(section,[]) if 'running' in c.get('state',{}))
            active[name]=(expected,timestamp(pod['metadata']['creationTimestamp']),pod['metadata'].get('uid'))
    except Exception:return unavailable
    measured={};metrics_ok=False
    try:
        pods=metrics if metrics is not None else json.loads(provider.kubectl('get','--raw','/apis/metrics.k8s.io/v1beta1/namespaces/'+provider.config['namespace']+'/pods',timeout=5))['items']
        if not isinstance(pods,list):raise ValueError('Invalid metrics inventory')
        seen=set()
        for pod in pods:
            name=pod['metadata']['name']
            if name in seen:raise ValueError('Duplicate metrics identity')
            seen.add(name)
            if name not in active:continue
            if pod['metadata']['namespace']!=provider.config['namespace']:raise ValueError('Different namespace')
            sampled=timestamp(pod['timestamp']);expected,created,uid=active[name]
            if not created<=sampled or not now-120<=sampled<=now+5:continue
            if strict:
                if pod['metadata'].get('uid',uid)!=uid:continue
                window=duration(pod.get('window'))
                if window is None or not 0<window<=120 or sampled-window<created:continue
            containers=pod['containers'];names=[c['name'] for c in containers]
            if len(names)!=len(set(names)) or not expected.issubset(names):continue
            cpu=memory=0
            for container in containers:
                cores=quantity(container['usage']['cpu']);size=quantity(container['usage']['memory'])
                if cores is None or size is None:raise ValueError('Unknown resource quantity')
                cpu+=cores;memory+=size/1048576
            if not numeric(cpu) or not numeric(memory):raise ValueError('Unbounded aggregate')
            measured[name]=(cpu,memory,sampled)
        metrics_ok=True
    except Exception:measured={}
    coverage={'status':'complete' if len(measured)==len(active) else 'incomplete',
              'activePods':len(active),'measuredPods':len(measured)}
    # A failed metrics API must not turn an empty namespace into a measured zero.
    if not metrics_ok:coverage['status']='unavailable'
    if coverage['status']!='complete':return {'status':'unavailable','coverage':coverage}
    cpu=sum(v[0] for v in measured.values());memory=sum(v[1] for v in measured.values())
    if not numeric(cpu) or not numeric(memory):return unavailable
    return {'status':'available','cpuCores':round(cpu,6),'memoryMiB':round(memory,2),
            'podCount':len(measured),'sampledAt':min((v[2] for v in measured.values()),default=now),'coverage':coverage}


def quantity(value):
    match=re.fullmatch(r'([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)([numkKMGTEP]|[KMGTPE]i)?',str(value))
    if not match:return None
    suffix=match.group(2) or ''
    powers={'':Decimal(1),'n':Decimal('1e-9'),'u':Decimal('1e-6'),'m':Decimal('1e-3'),'k':Decimal(1000),'K':Decimal(1000)}
    for index,prefix in enumerate('M G T P E'.split(),2):powers[prefix]=Decimal(1000)**index
    for index,prefix in enumerate('K M G T P E'.split(),1):powers[prefix+'i']=Decimal(1024)**index
    try:
        result=Decimal(match.group(1))*powers[suffix]
        return float(result) if result.is_finite() and 0<=result<=2**53 else None
    except (DecimalException,OverflowError):return None


def duration(value):
    if not isinstance(value,str) or not re.fullmatch(r'(?:[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|ms|s|m|h))+',value):return None
    units={'ns':1e-9,'us':1e-6,'µs':1e-6,'ms':.001,'s':1,'m':60,'h':3600}
    result=sum(float(number)*units[unit] for number,unit in re.findall(r'([0-9]+(?:\.[0-9]+)?)(ns|us|µs|ms|s|m|h)',value))
    return result if numeric(result) else None


def collect(provider,assignments=None):
    from .cluster_ownership import items,snapshot,unavailable
    namespace=provider.config['namespace']
    result={'namespace':namespace,'sampledAt':time.time(),'metrics':{'status':'unavailable'},'quotas':{'status':'unavailable','items':[]}}
    result['canaveral']=unavailable()
    try:pods=items(provider,'pods')
    except Exception:pods=False
    try:
        data=json.loads(provider.kubectl('get','--raw','/apis/metrics.k8s.io/v1beta1/namespaces/'+namespace+'/pods',timeout=5))
        measurements=data['items']
        if not isinstance(measurements,list):raise ValueError('Invalid metrics inventory')
    except Exception:measurements=False
    result['metrics']=pod_usage(provider,result['sampledAt'],pods,measurements)
    if isinstance(assignments,list) and isinstance(pods,list):
        try:
            before,selected=snapshot(provider,assignments,pods,items(provider,'virtualmachines.kubevirt.io'),items(provider,'virtualmachineinstances.kubevirt.io'))
            names={p['metadata']['name'] for p in selected}
            metrics=[p for p in measurements if p.get('metadata',{}).get('name') in names] if isinstance(measurements,list) else False
            observed=pod_usage(provider,result['sampledAt'],selected,metrics,strict=True)
            after,_=snapshot(provider,assignments,items(provider,'pods'),items(provider,'virtualmachines.kubevirt.io'),items(provider,'virtualmachineinstances.kubevirt.io'))
            if before!=after:raise ValueError('Owned inventory changed during measurement')
            result['canaveral']={'scope':'assigned-vm-pods','ownership':{'status':'complete','assignedMachines':len(assignments),'verifiedMachines':len(assignments)},'metrics':observed}
        except Exception:pass
    try:
        data=json.loads(provider.kubectl('get','resourcequotas','-o','json',timeout=5))
        items=[]
        keys=('requests.cpu','limits.cpu','requests.memory','limits.memory','requests.storage','persistentvolumeclaims')
        for item in data['items'][:50]:
            quota={'name':item['metadata']['name'],'hard':{},'used':{}}
            for section in ('hard','used'):
                for key,value in item.get('status',{}).get(section,{}).items():
                    if key not in keys:continue
                    amount=quantity(value)
                    if amount is not None:quota[section][key]=round(amount/(1048576 if 'memory' in key else 1073741824 if 'storage' in key else 1),6)
            items.append(quota)
        result['quotas']={'status':'available','items':items,'truncated':len(data['items'])>50}
    except Exception:pass
    return result


def validate(value):
    if not isinstance(value,dict) or set(value) not in ({'namespace','sampledAt','metrics','quotas'},{'namespace','sampledAt','metrics','quotas','canaveral'}):return False
    if not isinstance(value['namespace'],str) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,252}',value['namespace']):return False
    if not numeric(value['sampledAt']):return False
    metrics=value['metrics'];quotas=value['quotas']
    if not validate_metrics(metrics):return False
    if 'canaveral' in value:
        owned=value['canaveral']
        if not isinstance(owned,dict) or set(owned)!={'scope','ownership','metrics'} or owned['scope']!='assigned-vm-pods':return False
        ownership=owned['ownership']
        if not isinstance(ownership,dict) or ownership.get('status') not in ('complete','unavailable'):return False
        if ownership['status']=='unavailable':
            if set(ownership)!={'status'} or owned['metrics']!={'status':'unavailable','coverage':{'status':'unavailable'}}:return False
        else:
            if set(ownership)!={'status','assignedMachines','verifiedMachines'}:return False
            if any(type(ownership[k]) is not int or not 0<=ownership[k]<=2**53 for k in ('assignedMachines','verifiedMachines')):return False
            if ownership['assignedMachines']!=ownership['verifiedMachines']:return False
        if not validate_metrics(owned['metrics']) or 'coverage' not in owned['metrics']:return False
        if owned['metrics']['status']=='available' and 'sampledAt' not in owned['metrics']:return False
    if not isinstance(quotas,dict) or quotas.get('status') not in ('available','unavailable') or set(quotas)-{'status','items','truncated'}:return False
    if not isinstance(quotas.get('items'),list) or len(quotas['items'])>50:return False
    for quota in quotas['items']:
        if not isinstance(quota,dict) or set(quota)!={'name','hard','used'} or not isinstance(quota['name'],str) or len(quota['name'])>253:return False
        for section in ('hard','used'):
            if not isinstance(quota[section],dict) or len(quota[section])>6:return False
            if any(k not in ('requests.cpu','limits.cpu','requests.memory','limits.memory','requests.storage','persistentvolumeclaims') or not numeric(n) for k,n in quota[section].items()):return False
    return True


def validate_metrics(metrics):
    if not isinstance(metrics,dict) or metrics.get('status') not in ('available','unavailable'):return False
    if set(metrics)-{'status','cpuCores','memoryMiB','podCount','sampledAt','coverage'} or any(not numeric(n) for k,n in metrics.items() if k not in ('status','coverage')):return False
    if metrics['status']=='available' and not {'cpuCores','memoryMiB','podCount'}.issubset(metrics):return False
    if 'coverage' in metrics:
        coverage=metrics['coverage']
        if not isinstance(coverage,dict) or coverage.get('status') not in ('complete','incomplete','unavailable'):return False
        if set(coverage) not in ({'status'},{'status','activePods','measuredPods'}):return False
        if coverage['status']!='unavailable' and set(coverage)=={'status'}:return False
        if 'activePods' in coverage:
            if any(type(coverage[k]) is not int or not 0<=coverage[k]<=2**53 for k in ('activePods','measuredPods')):return False
            if coverage['measuredPods']>coverage['activePods']:return False
            if coverage['status']=='complete' and coverage['activePods']!=coverage['measuredPods']:return False
            if coverage['status']=='incomplete' and coverage['activePods']==coverage['measuredPods']:return False
        if metrics['status']=='available' and (coverage['status']!='complete' or metrics['podCount']!=coverage['measuredPods']):return False
    return True


def numeric(value):
    import math
    return type(value) in (int,float) and math.isfinite(value) and 0<=value<=2**53
