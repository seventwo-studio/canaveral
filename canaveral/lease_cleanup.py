"""Owned lease reclamation with an external, credential-free tombstone.

Native teardown supports the Apple adapter and the gated libvirt component.
Positively unstarted assignments
need no native teardown and can reclaim only their empty owned storage and local
credentials through the same exclusive assignment gate.
"""
import json
import os
import shutil
import time
import threading
import logging
from pathlib import Path

from .assignment_gate import assignment_access,paths
from .files import HostLock,save_json
from .model import Error,identifier,digest
from .owned_removal import assignment_fingerprint,sync_directory


class CleanupBlocked(Error):
    def __init__(self,reason):super().__init__('Lease cleanup is blocked.',409,code=reason)


def report(intent,attempt,state,reason=None):
    value={'id':intent['id'],'leaseId':intent['leaseId'],'attempt':attempt,'state':state}
    if reason:value['reason']=reason
    if state=='complete':value.update(executionStopped=True,storageRemoved=True,credentialsErased=True)
    return {'state':'stopped' if state=='complete' else 'stopping' if state=='running' else 'unknown','leaseFenced':True,'leaseCleanup':value}


def cleanup_assignment(agent,machine,runtime,image,folder):
    intent=machine['leaseCleanup'];lease=machine.get('lease',{})
    if intent['leaseId']!=lease.get('id') or lease.get('state') not in ('failed','released','expired') or machine['desired']!='stopped':
        raise Error('Cleanup requires its terminal pinned lease and stopped intent.',409)
    for key in ('id','leaseId'):identifier(intent[key])
    provider=runtime.config.get('provider')
    native_cleanup=provider=='apple' or provider=='libvirt' and callable(getattr(runtime,'stop_for_cleanup',None))
    folder=Path(folder);_,receipt=paths(folder,machine['id'])
    receipt.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    expected={'id':intent['id'],'machineId':machine['id'],'leaseId':lease['id'],'fingerprint':assignment_fingerprint(machine)}
    with HostLock(receipt.with_suffix('.lock')):
        if receipt.exists() or receipt.is_symlink():
            if receipt.is_symlink():raise Error('Cleanup receipt must not be a symbolic link.',409)
            proof=json.loads(receipt.read_text())
            if any(proof.get(key)!=value for key,value in expected.items()):raise Error('Cleanup receipt ownership differs.',409)
        else:proof={**expected,'phase':'planned','attempt':0}
        storage=Path(runtime.config['storage']).resolve()/machine['id']
        quarantine=folder.parent/('.erasing-'+machine['id']+'-'+intent['id'])
        if (native_cleanup and provider=='libvirt' and proof.get('evidence')!='never-started'
                and proof['phase'] in ('storageRemoved','erasing','removing','complete')):
            native=proof.get('nativeRemoval')
            if (not isinstance(native,dict) or set(native)!={'provider','storageRoot','receiptDigest'}
                    or native.get('provider')!='libvirt' or native.get('storageRoot')!=digest(str(storage.parent))
                    or not isinstance(native.get('receiptDigest'),str) or len(native['receiptDigest'])!=64
                    or any(c not in '0123456789abcdef' for c in native['receiptDigest'])):
                return report(intent,max(1,proof['attempt']),'blocked','ownership')
        if proof['phase']=='complete':
            if not native_cleanup and proof.get('evidence')!='never-started':
                return report(intent,max(1,proof['attempt']),'blocked','unsupported')
            if any(p.exists() or p.is_symlink() for p in (storage,folder,quarantine)):return report(intent,proof['attempt'],'blocked','recovery')
            return report(intent,proof['attempt'],'complete')
        if time.time()<intent.get('notBefore',0):return report(intent,max(1,proof['attempt']),'blocked',proof.get('reason','recovery'))
        proof.update(attempt=max(proof['attempt'],intent['attempts'])+1)
        save_json(receipt,proof) # Block new shared work before asking for exclusivity.
        if hasattr(agent,'lock') and hasattr(agent,'reports'):
            with agent.lock:agent.reports[machine['id']]=report(intent,proof['attempt'],'running')
        try:
            if any(p.is_symlink() for p in (storage,folder,quarantine)):raise CleanupBlocked('ownership')
            agent.access_runner.close_machine(machine['id'])
            with agent.display_controls.lock:endpoints=[e for e in agent.display_controls.endpoints if e.machine==machine['id']]
            for endpoint in endpoints:endpoint.close()
            if hasattr(runtime,'shells'):
                runtime.shells.revoke({machine['id']})
                with runtime.shells.lock:
                    if any(key[0]==machine['id'] for key in (*runtime.shells.sessions,*runtime.shells.closing)):
                        raise CleanupBlocked('sessions_pending')
            if runtime.access:runtime.access.close_machine(machine['id'])
            with assignment_access(machine,folder,exclusive=True):
                from .assignment_process import helpers_closed
                if not helpers_closed(machine,folder):raise CleanupBlocked('operations_pending')
                deletion=folder/'deletion.json'
                has_deletion=deletion.exists() or deletion.is_symlink()
                if not has_deletion and any(storage.parent.glob('.removing-'+machine['id']+'-*')):raise CleanupBlocked('recovery')
                if proof['phase']=='planned' and not has_deletion and agent.lease_guard.never_started(machine['id'],lease['id']) is True:
                    # A durable pre-execution record is positive evidence here;
                    # an unexplained missing disk after execution is still blocked.
                    if storage.exists():
                        owner=storage/'canaveral-owner.json'
                        if storage.is_symlink() or {p.name for p in storage.iterdir()}!={'canaveral-owner.json'} or owner.is_symlink() or json.loads(owner.read_text()).get('fingerprint')!=expected['fingerprint']:
                            raise CleanupBlocked('ownership')
                    if folder.exists():
                        assignment=folder/'assignment.json'
                        if folder.is_symlink() or not assignment.is_file() or assignment.is_symlink():raise CleanupBlocked('ownership')
                        owned=json.loads(assignment.read_text())
                        if owned.get('fingerprint')!=expected['fingerprint'] or owned.get('leaseId')!=lease['id']:raise CleanupBlocked('ownership')
                    proof.update(phase='unstarted',evidence='never-started',executionStopped=True,storageExisted=storage.exists())
                    save_json(receipt,proof)
                # The guard is checked only after exclusive assignment access
                # and helper closure. A possible launch cannot race this proof.
                # Recovery trusts only the exact intent-bound durable evidence;
                # a missing disk or a stopped flag is never a substitute.
                if not native_cleanup and proof.get('evidence')!='never-started':
                    raise CleanupBlocked('unsupported')
                if proof['phase']=='unstarted':
                    if storage.exists():
                        if not proof['storageExisted'] or storage.is_symlink() or {p.name for p in storage.iterdir()}-{'canaveral-owner.json'}:
                            raise CleanupBlocked('ownership')
                        owner=storage/'canaveral-owner.json'
                        if owner.exists():
                            if owner.is_symlink() or json.loads(owner.read_text()).get('fingerprint')!=expected['fingerprint']:raise CleanupBlocked('ownership')
                            owner.unlink()
                        storage.rmdir();sync_directory(storage.parent)
                    proof['phase']='storageRemoved' if folder.exists() else 'complete';save_json(receipt,proof)
                if proof['phase']=='planned' and not has_deletion and provider=='apple':
                    from .provisioning import preboot_storage
                    if preboot_storage(machine,folder,storage):
                        proof.update(phase='preboot',executionStopped=True,storageExisted=storage.exists())
                        save_json(receipt,proof)
                if proof['phase']=='preboot':
                    if proof['storageExisted']:
                        try:removed=runtime.remove_owned_storage(machine,image,folder,intent['id'],preboot=True)
                        except Exception:raise CleanupBlocked('storage_removal')
                        if removed.get('state')!='complete' or removed.get('id')!=intent['id'] or removed.get('machineId')!=machine['id']:
                            raise CleanupBlocked('storage_removal')
                    elif storage.exists() or storage.is_symlink():raise CleanupBlocked('recovery')
                    proof['phase']='storageRemoved';save_json(receipt,proof)
                if proof['phase']=='planned':
                    if folder.is_symlink() or not folder.is_dir():raise CleanupBlocked('ownership')
                    assignment=folder/'assignment.json'
                    if assignment.is_symlink() or not assignment.is_file() or json.loads(assignment.read_text()).get('fingerprint')!=expected['fingerprint']:
                        raise CleanupBlocked('ownership')
                    deletion=folder/'deletion.json'
                    if deletion.exists() or deletion.is_symlink():
                        if deletion.is_symlink():raise CleanupBlocked('ownership')
                        previous=json.loads(deletion.read_text())
                        states=('planned','quarantined','retired','erasing','cleared','removing','complete') if provider=='libvirt' else ('planned','removing','complete')
                        if any(previous.get(k)!=expected[k] for k in ('id','machineId','fingerprint')) or previous.get('state') not in states:
                            raise CleanupBlocked('ownership')
                        # The owned remover persisted positive stop evidence
                        # before its rename. Never recreate storage on recovery.
                    else:
                        owner=storage/'canaveral-owner.json'
                        if not storage.is_dir() or owner.is_symlink() or not owner.is_file() or json.loads(owner.read_text()).get('fingerprint')!=expected['fingerprint']:
                            raise CleanupBlocked('ownership')
                        # No guest preparation is entered while closing execution.
                        resolved={**image,'_leaseAuthorization':lambda:agent.lease_guard.authorization(machine['id'],lease['id'])}
                        # Libvirt's ordinary reconciliation takes a shared gate
                        # and may prepare execution. Cleanup already holds the
                        # exclusive gate and enters only its dedicated fencer.
                        stopped=runtime.stop_for_cleanup(machine,resolved,folder) if provider=='libvirt' else runtime.reconcile(machine,resolved,folder)
                        if stopped.get('state')!='stopped':raise CleanupBlocked('execution_pending')
                    proof['executionStopped']=True;save_json(receipt,proof)
                    try:removed=runtime.remove_owned_storage(machine,image,folder,intent['id'])
                    except Exception:raise CleanupBlocked('storage_removal')
                    if removed.get('state')!='complete' or removed.get('id')!=intent['id'] or removed.get('machineId')!=machine['id']:
                        raise CleanupBlocked('storage_removal')
                    if provider=='libvirt':
                        proof['nativeRemoval']={'provider':'libvirt','storageRoot':digest(str(storage.parent)),'receiptDigest':digest(removed)}
                    proof['phase']='storageRemoved';save_json(receipt,proof)
                if storage.exists():raise CleanupBlocked('recovery')
                if proof['phase']=='storageRemoved':
                    if folder.is_symlink() or quarantine.exists():raise CleanupBlocked('credential_erasure')
                    if not folder.is_dir():raise CleanupBlocked('credential_erasure')
                    proof['phase']='erasing';save_json(receipt,proof)
                if proof['phase']=='erasing':
                    if folder.is_symlink() or quarantine.is_symlink():raise CleanupBlocked('credential_erasure')
                    if folder.exists():
                        if quarantine.exists():raise CleanupBlocked('credential_erasure')
                        assignment=folder/'assignment.json'
                        if assignment.is_symlink() or not assignment.is_file() or json.loads(assignment.read_text()).get('fingerprint')!=expected['fingerprint']:
                            raise CleanupBlocked('ownership')
                        os.rename(folder,quarantine);sync_directory(folder.parent)
                    if not quarantine.is_dir():raise CleanupBlocked('credential_erasure')
                    assignment=quarantine/'assignment.json'
                    if assignment.is_symlink() or not assignment.is_file() or json.loads(assignment.read_text()).get('fingerprint')!=expected['fingerprint']:
                        raise CleanupBlocked('ownership')
                    proof['phase']='removing';save_json(receipt,proof)
                if proof['phase']=='removing':
                    if folder.exists() or quarantine.is_symlink():raise CleanupBlocked('credential_erasure')
                    if quarantine.exists():
                        if not shutil.rmtree.avoids_symlink_attacks:raise CleanupBlocked('credential_erasure')
                        shutil.rmtree(quarantine);sync_directory(folder.parent)
                    proof['phase']='complete';proof.pop('reason',None);save_json(receipt,proof)
                if proof['phase']!='complete':raise CleanupBlocked('recovery')
                return report(intent,proof['attempt'],'complete')
        except Exception as error:
            reason=error.code if isinstance(error,CleanupBlocked) else 'operations_pending' if isinstance(error,Error) and error.code=='assignment_busy' else 'recovery'
            proof['reason']=reason;save_json(receipt,proof)
            value=report(intent,proof['attempt'],'blocked',reason)
            if proof.get('executionStopped') and reason not in ('ownership','recovery'):value['state']='stopped'
            return value


class LeaseCleanupRunner:
    def __init__(self,agent):self.agent=agent;self.lock=threading.Lock();self.workers={}

    def assignments(self):
        with self.agent.lock:current=list(self.agent.assignments)
        return self.agent.lease_guard.assignments(current)

    def process(self,machine_id):
        retry_at=0
        while not self.agent.stopping.is_set():
            machine=next((m for m in self.assignments() if m['id']==machine_id and m.get('leaseCleanup')),None)
            if not machine:return
            until=max(retry_at,machine['leaseCleanup'].get('notBefore',0))-time.time()
            if until>0:
                self.agent.stopping.wait(min(1,until));continue
            try:
                value=self.agent.reconcile(machine)
                with self.agent.lock:self.agent.reports[machine_id]=value
                cleanup=value['leaseCleanup']
                retry_at=time.time()+min(60,2**min(cleanup['attempt'],6)) if cleanup['state']=='blocked' else 0
            except Exception:
                logging.error('Lease cleanup recovery requires inspection; resources remain reserved.')
                value=report(machine['leaseCleanup'],max(1,machine['leaseCleanup']['attempts']+1),'blocked','recovery')
                with self.agent.lock:self.agent.reports[machine_id]=value
                retry_at=time.time()+5
            self.agent.stopping.wait(.2)

    def work(self):
        while not self.agent.stopping.wait(.1):
            try:
                assignments=self.assignments()
                with self.lock:
                    for machine in assignments:
                        if not machine.get('leaseCleanup') or machine['id'] in self.workers:continue
                        worker=threading.Thread(target=self.process,args=(machine['id'],),daemon=True)
                        self.workers[machine['id']]=worker
                        try:worker.start()
                        except RuntimeError:
                            self.workers.pop(machine['id'],None)
                            logging.error('Lease cleanup worker unavailable; reservations are retained.')
                    for key,worker in list(self.workers.items()):
                        if not worker.is_alive():self.workers.pop(key,None)
            except Exception:logging.error('Lease cleanup scheduling requires inspection; nothing was reclaimed.')

    def close(self):
        with self.lock:workers=list(self.workers.values())
        deadline=time.monotonic()+6
        for worker in workers:worker.join(max(0,deadline-time.monotonic()))
