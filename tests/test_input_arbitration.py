from canaveral.lease_clock import execution_monotonic
import json
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

from canaveral.display_access import DisplayControls, InputDenied
from canaveral.model import Error
from canaveral.providers.mobile import Mobile


class InputArbitrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.controls=DisplayControls(self.root/'input.json')
        self.machine={'id':str(uuid.uuid4()),'desired':'running'}
        self.epoch={'startedAt':1,'identity':'first'}
        self.provider=Mobile({},self.root);self.provider.control=Mock(return_value={'posted':True})

    def operation(self,action='tap',**args):
        return {'id':str(uuid.uuid4()),'action':action,'arguments':args or {'x':1,'y':2},'expiresAt':time.time()+30}

    def run_operation(self,operation):
        return self.provider.operate(self.machine,{},self.root,operation,
            input_guard=lambda:self.controls.discrete(self.machine['id'],operation['id'],lambda:self.epoch,lambda:True))

    def test_busy_refusal_is_durable_and_new_request_can_run_after_release(self):
        machine=self.machine['id']
        self.assertEqual(self.controls.claim(machine,'viewer',self.epoch,lambda:True),'owned')
        op=self.operation();first=self.run_operation(op)
        self.assertEqual(first['state'],'failed');self.assertEqual(first['result']['code'],'input_busy')
        self.provider.control.assert_not_called()
        self.controls.release(machine,'viewer',self.epoch,True)
        self.assertEqual(self.run_operation(op),first)
        self.provider.control.assert_not_called()
        fresh=self.operation();self.assertEqual(self.run_operation(fresh)['state'],'succeeded')
        self.assertEqual(self.controls.records[machine]['phase'],'idle')
        self.run_operation(fresh);self.assertEqual(self.provider.control.call_count,1)

    def test_inflight_action_excludes_viewers_but_not_other_machines(self):
        entered=threading.Event();complete=threading.Event();report=[]
        def action(*args):entered.set();complete.wait(3);return {'posted':True}
        self.provider.control.side_effect=action
        op=self.operation();worker=threading.Thread(target=lambda:report.append(self.run_operation(op)))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.controls.claim(self.machine['id'],'viewer',self.epoch,lambda:True),'busy')
            self.assertEqual(self.controls.claim(self.machine['id'],op['id'],self.epoch,lambda:True),'busy')
            self.assertEqual(self.controls.claim(str(uuid.uuid4()),'other',self.epoch,lambda:True),'owned')
            # The operation receipt lock prevents competing input channels from
            # dispatching the same operation while its first effect is running.
            with self.assertRaises(RuntimeError):self.run_operation(op)
        finally:complete.set();worker.join(3)
        self.assertFalse(worker.is_alive());self.assertEqual(report[0]['state'],'succeeded')
        self.assertEqual(self.provider.control.call_count,1)

    def test_unknown_effect_blocks_handover_and_is_not_replayed_after_boot(self):
        self.provider.control.side_effect=Error('Fixture provider timeout')
        op=self.operation();report=self.run_operation(op)
        self.assertEqual(report['state'],'unknown')
        self.assertEqual(self.controls.claim(self.machine['id'],'viewer',self.epoch,lambda:True),'reset-uncertain')
        self.epoch={'startedAt':2,'identity':'second'}
        self.assertEqual(self.controls.claim(self.machine['id'],'viewer',self.epoch,lambda:True),'owned')
        self.assertEqual(self.run_operation(op),report);self.assertEqual(self.provider.control.call_count,1)

    def test_definite_preflight_refusal_releases_input(self):
        self.provider.control.side_effect=InputDenied('Stale target',409,code='input_rejected')
        report=self.run_operation(self.operation())
        self.assertEqual(report['state'],'failed');self.assertEqual(report['result']['code'],'input_rejected')
        self.assertEqual(self.controls.records[self.machine['id']]['phase'],'idle')
        self.assertEqual(self.controls.claim(self.machine['id'],'viewer',self.epoch,lambda:True),'owned')

    def test_lost_authorization_does_not_dispatch_or_leave_active_claim(self):
        allowed=iter([True,True,False])
        with self.assertRaises(InputDenied):
            with self.controls.discrete(self.machine['id'],str(uuid.uuid4()),lambda:self.epoch,lambda:next(allowed)):
                self.fail('Authorization must precede dispatch')
        self.assertEqual(self.controls.records[self.machine['id']]['phase'],'idle')

    def test_agent_dispatch_blocks_input_but_allows_read_operations(self):
        from canaveral.host import Agent
        from test_devices import config
        agent=Agent(config(),'http://127.0.0.1:1',self.root/'agent')
        agent.context=Mock(return_value=(self.provider,{},self.root))
        agent.assignments=[self.machine];agent.last_contact=execution_monotonic()
        agent.reports={self.machine['id']:{'state':'running'}}
        agent.display_controls.claim(self.machine['id'],'viewer',None,lambda:True)
        tap={**self.operation(),'machineId':self.machine['id']}
        read={**self.operation('screenshot'),'arguments':{},'machineId':self.machine['id']}
        agent.device_operations=[tap,read]
        agent.device_work()
        self.assertEqual(agent.device_reports[tap['id']]['result']['code'],'input_busy')
        self.assertEqual(agent.device_reports[read['id']]['state'],'succeeded')
        self.assertEqual([call.args[3]['action'] for call in self.provider.control.call_args_list],['screenshot'])


if __name__=='__main__':unittest.main()
