"""Bounded environment checks and host-wide telemetry; no environment secrets."""
import hashlib
import math
import os
import platform
import shutil
import re
import subprocess
import threading
import tempfile
import time
from pathlib import Path

from .model import Error
from .providers.base import architecture


_cpu_primed = set()
_process_state = threading.local()


def process_usage(psutil,owned=None):
    """Measure the runner tree plus explicitly verified assigned runtime identities."""
    previous_samples=getattr(_process_state,'samples',{})
    groups={key:dict(id=key,cpuPercent=0,memoryMiB=0,processCount=0) for key in ('services','virtualMachines','simulators')}
    extras=[];unavailable=set()
    if owned is not None:
        try:extras,unavailable=owned(psutil)
        except Exception:unavailable=set(groups)
    scope='runner-and-owned-processes' if extras or unavailable else 'runner-process-tree'
    current={};seen=set();now=time.monotonic();count=psutil.cpu_count()
    if type(count) is not int or count<=0:count=None
    try:
        root=psutil.Process()
        processes=[*extras,*[(p,None,None) for p in (root,*root.children(recursive=True))]]
    except Exception:
        for group in groups.values():group.update(cpuPercent=None,memoryMiB=None,processCount=None)
        _process_state.samples={}
        return {'scope':scope,'categories':list(groups.values())}
    for process,expected_birth,category in processes:
        group=groups.get(category)
        try:
            identity=(process.pid,process.create_time())
            if expected_birth is not None and identity[1]!=expected_birth:raise ValueError('Runtime process identity changed')
            if identity in seen:continue
            if group is None:
                name=process.name().lower()
                executable=process.exe().lower().replace('\\','/') if name.startswith('qemu-system') else ''
                category='simulators' if name.startswith(('emulator','simulator','qemu-system-android')) or '/emulator/' in executable else 'virtualMachines' if 'canaveralvmrunner' in name or name.startswith('qemu-system') else 'services'
                group=groups[category]
            # A failed explicitly owned sample must not reappear as a generic
            # tree helper in another category later in this same observation.
            seen.add(identity)
            cpu=process.cpu_times();rss=process.memory_info().rss
            if any(type(n) not in (int,float) or not math.isfinite(n) or n<0 for n in (cpu.user,cpu.system,rss)):
                raise ValueError('Runtime process counters are unavailable')
            if expected_birth is not None and psutil.Process(process.pid).create_time()!=expected_birth:
                raise ValueError('Runtime process identity changed during measurement')
            verifier=getattr(type(process),'verify_resource_identity',None)
            if verifier is not None:verifier(process)
            total=cpu.user+cpu.system;previous=previous_samples.get(identity)
            if not math.isfinite(total):raise ValueError('Runtime process counters overflowed')
            current[identity]=(now,total)
            group['processCount']+=1
            if count is not None and previous and total>=previous[1] and now>previous[0] and group['cpuPercent'] is not None:
                group['cpuPercent']+=max(0,total-previous[1])/(now-previous[0])/count*100
            else:group['cpuPercent']=None
            if group['memoryMiB'] is not None:group['memoryMiB']+=rss/1048576
        except Exception:
            if group is None:unavailable.update(groups)
            else:unavailable.add(group['id'])
    _process_state.samples=current
    for group in groups.values():
        if group['id'] in unavailable:group.update(cpuPercent=None,memoryMiB=None,processCount=None)
        if group['cpuPercent'] is not None:group['cpuPercent']=round(min(100,group['cpuPercent']),2)
        if group['memoryMiB'] is not None:group['memoryMiB']=round(group['memoryMiB'],1)
    return {'scope':scope,'categories':list(groups.values())}


def sample(config,owned=None):
    # Cluster workers measure the runner, never claim its RAM is cluster capacity.
    value={'scope':'runner' if config['provider']=='kubevirt' else 'host',
           'domain':hashlib.sha256(platform.node().encode()).hexdigest()[:24],
           'sampledAt':time.time(), 'cpuPercent':None, 'cpuCount':None,
           'memoryTotalMiB':None,'memoryAvailableMiB':None,'diskTotalGiB':None,'diskFreeGiB':None}
    try:
        import psutil
        value['canaveral']=process_usage(psutil,owned)
        cpu=psutil.cpu_percent(interval=None)
        thread_id=threading.get_ident()
        value.update(cpuPercent=cpu if thread_id in _cpu_primed else None,cpuCount=psutil.cpu_count())
        _cpu_primed.add(thread_id)
        memory=psutil.virtual_memory()
        value.update(memoryTotalMiB=round(memory.total/1048576,1),memoryAvailableMiB=round(memory.available/1048576,1))
        path=Path(config.get('storage','.')).expanduser().resolve()
        while not path.exists() and path.parent!=path:path=path.parent
        disk=psutil.disk_usage(str(path))
        value.update(diskTotalGiB=round(disk.total/1073741824,2),diskFreeGiB=round(disk.free/1073741824,2))
    except Exception:
        # Missing collectors or denied OS access must not suppress heartbeats.
        pass
    return value


def inspect(config, provider, state_dir):
    if hasattr(provider,'runtimes'):
        reports={name:inspect(runtime.config,runtime,runtime.state) for name,runtime in provider.runtimes.items()}
        checks=[{**check,'id':name+':'+check['id'],'label':name+' · '+check['label']} for name,report in reports.items() for check in report['checks']]
        expected={'macos':'Darwin','linux':'Linux','windows':'Windows'}[config['provider']]
        checks.insert(0,{'id':'host-platform','label':'Host operating system','status':'passed' if platform.system()==expected else 'failed','detail':platform.system()+'; configured '+config['provider']+'.'})
        capabilities={key:any(r['capabilities'].get(key,False) for r in reports.values()) for key in next(iter(reports.values()))['capabilities']}
        return {'status':'failed' if any(c['status']=='failed' for c in checks) else 'warning' if any(c['status']=='warning' for c in checks) else 'passed',
                'checkedAt':time.time(),'checks':checks,'capabilities':capabilities,
                'environment':{'system':platform.system(),'arch':architecture() or 'unknown','python':platform.python_version(),'runtimes':', '.join(sorted(reports))}}
    checks=[]
    def add(key,label,status,detail):
        checks.append({'id':key,'label':label,'status':status,'detail':detail})
    system=platform.system()
    expected={'apple':('Darwin',),'ios':('Darwin',),'android':('Darwin','Linux'),
              'libvirt':('Linux',),'hyperv':('Windows',),'kubevirt':('Darwin','Linux','Windows')}.get(config['provider'],(system,))
    add('platform','Operating system','passed' if system in expected else 'failed',
        system+' / '+(architecture() or platform.machine())+'; requires '+', '.join(expected)+'.')
    try:
        root=Path(config.get('storage',state_dir))
        if not root.is_absolute():raise Error('Set an absolute storage directory.')
        root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryFile(dir=str(root)) as probe:probe.write(b'canaveral-check');probe.flush()
        add('storage','Storage access','passed','Runner can write its configured storage directory.')
    except (OSError,Error):
        add('storage','Storage access','failed','Set an absolute, writable storage directory owned by this runner account.')
    tools={'libvirt':['virsh','qemu-img'],'hyperv':['powershell'],'ios':[config.get('xcrun','xcrun'),config.get('idb','idb'),'idb_companion'],
           'apple':[config.get('runner','CanaveralVMRunner')],'kubevirt':['kubectl'],
           'android':[provider.tool(name) for name in ('adb','emulator','avdmanager')]+['java'] if config['provider']=='android' and config.get('androidSDK') else []}.get(config['provider'],[])
    for index,tool in enumerate(tools):
        available=shutil.which(tool) is not None
        detail='Executable available.'
        tool_name=Path(tool).name.lower()
        if available and tool_name in ('virsh','qemu-img','java','adb','emulator','xcrun','idb','kubectl'):
            argv=[tool,'-version' if tool_name in ('java','emulator') else 'version' if tool_name=='adb' else '--version']
            if tool_name=='kubectl':argv=[tool,'version','--client=true','-o','json']
            try:
                completed=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=5,check=False)
                version=re.search(r'\b[0-9]+\.[0-9]+(?:\.[0-9]+)?\b',completed.stdout[:2000].decode(errors='replace'))
                if version:detail='Executable available; version '+version.group(0)+'.'
            except (OSError,subprocess.TimeoutExpired):pass
        add('tool-'+str(index),Path(tool).name,'passed' if available else 'failed',
            detail if available else 'Install this prerequisite or correct its path in the runner configuration.')
    libvirt_lease_artifact=False
    if config['provider']=='libvirt':
        if config.get('leaseDeadlineLibrary') is None:
            add('libvirt-lease-artifact','Linux lease deadline artifact','warning',
                'No native deadline library configured. Administrative VMs remain separate from consumer lease readiness.')
        else:
            try:
                from .libvirt_readiness import deadline_artifact
                artifact=deadline_artifact(config['leaseDeadlineLibrary'],architecture())
                libvirt_lease_artifact=True
                add('libvirt-lease-artifact','Linux lease deadline artifact','passed',
                    'Owned ELF snapshot, host architecture and required function exports match; SHA-256 '+artifact['sha256']+'. No code was loaded.')
            except Error:
                add('libvirt-lease-artifact','Linux lease deadline artifact','failed',
                    'Use an owned, private Linux shared library built for this host with the deadline install/arm exports. No code was loaded.')
        add('libvirt-lease-acceptance','Native consumer lease verification','warning',
            'Artifact checks do not establish expiry, suspend, owned cleanup, restart or fresh-lease isolation. Ordinary consumer admission remains disabled.')
    android_upload_helper=False
    if config['provider']=='android':
        if config.get('transferHelperManifest') is None:
            add('android-upload-helper','Android durable upload helper','warning',
                'No native helper configured. Legacy drive uploads do not confirm durable publication.')
        else:
            try:
                from .android_transfer import load_helper
                for image in config['templates']:load_helper(config,image)
                android_upload_helper=bool(config['templates'])
                add('android-upload-helper','Android durable upload helper','passed' if android_upload_helper else 'warning',
                    'Configured helper artifacts match image architectures, API levels and checksums; guest execution still needs acceptance.' if android_upload_helper else 'No configured Android images to validate.')
            except Error:
                add('android-upload-helper','Android durable upload helper','failed',
                    'Helper manifest, image API level, architecture or checksum validation failed. Rebuild or correct the configured artifacts.')
    measured=sample(config)
    if config['provider']!='kubevirt':
        too_large=any(measured[key] is not None and config['capacity'][resource]>measured[key]
                      for key,resource in (('cpuCount','cpu'),('memoryTotalMiB','memoryMiB')))
        add('capacity','Offered host capacity','failed' if too_large else 'passed' if measured['memoryTotalMiB'] else 'warning',
            'Offered CPU or memory exceeds this host; lower the configured capacity.' if too_large else 'Offered capacity fits measured CPU and memory. Divide capacity between runners sharing the host.' if measured['memoryTotalMiB'] else 'Physical resources unavailable; install psutil and verify the configured capacity.')
        low=measured['diskFreeGiB'] is not None and config['capacity']['diskGiB']>measured['diskFreeGiB']
        add('disk-space','Storage headroom','warning' if low else 'passed',
            'Offered logical disk capacity exceeds currently free storage. Existing disks and thin provisioning affect physical usage.' if low else 'Storage headroom measured; logical reservations remain separate from physical usage.')
    else:
        add('pool','Cluster capacity scope','warning','This is configured capacity for one namespace pool. Runner metrics are not cluster utilization; divide capacity across overlapping pools and nodes.')
    if any(c['status']=='failed' for c in checks):
        add('backend','Runtime and image validation','skipped','Fix failed prerequisites, then run checks again.')
    else:
        try:
            provider.check()
            add('backend','Runtime and image validation','passed','Backend connection and configured image bindings passed provider validation.')
        except Exception:
            # SDK stderr can contain credentials/URLs. Detailed output stays local.
            add('backend','Runtime and image validation','failed',
                'Provider validation failed. Verify runtime access, permissions, image bindings and configured network/namespace; run the provider tools locally for details.')
    add('images','Image catalogue','passed' if config['templates'] else 'warning',
        str(len(config['templates']))+' configured images.' if config['templates'] else 'Connected without images. Add installed image definitions to the runner config, then restart it.')
    images=config['templates']
    mobile=config['provider'] in ('android','ios')
    guest=any(t.get('guestAccess') for t in images)
    capabilities={'virtualMachines':config['provider'] in ('apple','libvirt','hyperv','kubevirt'),
                  'simulators':mobile, 'desktopStream':mobile or guest,'files':mobile or guest,
                  'shell':config['provider']=='android' or guest,'accessibility':mobile or guest,
                  'outboundControl':True,'remoteDesktopBroker':False,'androidUploadHelper':android_upload_helper,
                  'libvirtLeaseArtifact':libvirt_lease_artifact}
    status='failed' if any(c['status']=='failed' for c in checks) else 'warning' if any(c['status']=='warning' for c in checks) else 'passed'
    return {'status':status,'checkedAt':time.time(),'checks':checks,'capabilities':capabilities,
            'environment':{'system':system,'arch':architecture() or 'unknown','python':platform.python_version()}}
