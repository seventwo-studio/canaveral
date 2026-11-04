"""Persisted lease execution deadlines, independent of controller availability."""
import copy
import json
import math
import threading
import time
from pathlib import Path

from .files import save_json
from .model import Error, identifier
from .lease_clock import execution_monotonic


class LeaseGuard:
    def __init__(self,state,clock=time.time,monotonic=execution_monotonic):
        self.path=Path(state)/'lease-execution.json'
        self.clock,self.monotonic=clock,monotonic
        self.lock=threading.RLock();self.records={};self.deadlines={}
        self.history_known=self.path.exists() or not (Path(state)/'identity.json').exists()
        if self.path.exists():
            self.records=json.loads(self.path.read_text())
            changed=False
            for id,record in self.records.items():
                identifier(id)
                # Without a fresh server time, use wall time conservatively on restart.
                remaining=record['machine']['lease']['authorizationDeadline']-self.clock()-5
                if self.clock()<record['receivedAt']-5 or remaining<=0:
                    if not record['fenced']:changed=True
                    record['fenced']=True
                self.deadlines[id]=self.monotonic()+max(0,remaining)
            if changed:self._save()

    def _save(self):save_json(self.path,self.records)

    def observe(self,machines,round_trip):
        with self.lock:
            now=self.monotonic();wall=self.clock();changed=False
            if not self.records and not any(m.get('lease') for m in machines) and (not self.history_known or not self.path.exists()):
                changed=True # Persist an authenticated empty assignment history.
            seen=set()
            for machine in machines:
                id=identifier(machine['id']);lease=machine.get('lease');previous=self.records.get(id)
                seen.add(id)
                if not lease:
                    if previous:previous['fenced']=True;changed=True
                    continue
                identifier(lease.get('id'))
                for key in ('authorizationDeadline','controllerNow'):
                    n=lease.get(key)
                    if type(n) not in (float,int) or not math.isfinite(n) or not 0<=n<=2**53:raise Error('Invalid lease deadline report.',400)
                revision=lease.get('revision')
                if type(revision) is not int or revision<1:raise Error('Invalid lease revision.',400)
                if previous and previous['machine']['lease']['id']!=lease['id']:
                    previous['fenced']=True;self._save()
                    raise Error('Machine lease ownership changed.',409)
                if previous and previous.get('retired'):continue
                fenced=bool(previous and (previous['fenced'] or now>=self.deadlines[id]))
                if previous and revision<previous['machine']['lease']['revision']:continue
                fenced=fenced or lease.get('state') not in ('provisioning','ready') or abs(wall-lease['controllerNow'])>5+round_trip
                deadline=now+max(0,lease['authorizationDeadline']-lease['controllerNow']-round_trip)
                if previous and lease['authorizationDeadline']<=previous['machine']['lease']['authorizationDeadline']:
                    deadline=min(deadline,self.deadlines[id])
                fenced=fenced or deadline<=now
                self.records[id]={'machine':copy.deepcopy(machine),'receivedAt':wall,'fenced':fenced,
                                  'executionStarted':previous.get('executionStarted',True) if previous else not self.history_known}
                self.deadlines[id]=deadline;changed=True
            for id,record in self.records.items():
                if record.get('retired'):continue
                if id not in seen:record['fenced']=True;changed=True
            if changed:
                self._save();self.history_known=True

    def allowed(self,machine_id):
        with self.lock:
            record=self.records.get(machine_id)
            if not record:return True
            if not record['fenced'] and self.monotonic()>=self.deadlines[machine_id]:
                record['fenced']=True;self._save()
            return not record['fenced']

    def assignments(self,current):
        with self.lock:
            result={m['id']:copy.deepcopy(m) for m in current}
            for id,record in self.records.items():
                if record.get('retired'):
                    result.pop(id,None);continue
                if id not in result:result[id]=copy.deepcopy(record['machine'])
                if not self.allowed(id):
                    result[id]['desired']='stopped'
                    result[id]['leaseFenced']=True
            return list(result.values())

    def fenced_machines(self):
        """Observe expiry independently of the potentially busy VM work loop."""
        with self.lock:
            return {machine_id for machine_id,record in self.records.items() if not record.get('retired') and not self.allowed(machine_id)}

    def retire(self,machine_id,lease_id,cleanup_id):
        with self.lock:
            record=self.records.get(identifier(machine_id))
            if not record or record['machine']['lease']['id']!=identifier(lease_id):raise Error('Cleanup acknowledgement has different lease ownership.',409)
            intent=record['machine'].get('leaseCleanup')
            if not intent or intent.get('id')!=identifier(cleanup_id) or intent.get('leaseId')!=lease_id:
                raise Error('Cleanup acknowledgement has a different durable intent.',409)
            record.update(fenced=True,retired=True,cleanupId=identifier(cleanup_id));self._save()

    def begin_execution(self,machine_id,lease_id):
        with self.lock:
            record=self.records.get(identifier(machine_id))
            if not record or record['machine']['lease']['id']!=identifier(lease_id) or not self.allowed(machine_id):
                raise Error('Leased execution is not authorized.',410)
            if record.get('executionStarted') is not True:
                record['executionStarted']=True;self._save()

    def never_started(self,machine_id,lease_id):
        with self.lock:
            record=self.records.get(identifier(machine_id))
            return bool(record and record['machine']['lease']['id']==identifier(lease_id) and record.get('executionStarted') is False)

    def authorization(self,machine_id,lease_id):
        """A bounded remaining duration for an independent runtime supervisor."""
        with self.lock:
            record=self.records.get(identifier(machine_id))
            if not record or record['machine']['lease']['id']!=identifier(lease_id):
                raise Error('Native execution requires the pinned lease deadline.',409)
            allowed=self.allowed(machine_id)
            return {'leaseID':lease_id,'revision':record['machine']['lease']['revision'],
                    'remainingSeconds':max(0,self.deadlines[machine_id]-self.monotonic()) if allowed else 0,
                    'fenced':not allowed}
