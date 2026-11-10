import copy
import json
import pathlib
import tempfile
import threading
import time
import unittest

from seven_agent import Agent, EPOCH, identifier, now


class ManualAgent(Agent):
    def schedule(self): pass


class Relay:
    def __init__(self, turns): self.turns = iter(turns); self.requests = []
    def stream(self, request, cancel, deadline):
        self.requests.append(copy.deepcopy(request))
        yield from next(self.turns)


def call(name, arguments):
    return dict(type="function_call", name=name, arguments=json.dumps(arguments), call_id=identifier())


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.agent = ManualAgent(self.temp.name)
        self.agent.state["settings"]["model"] = "test-model"
        self.task = self.agent.task("Help me")
        self.cancel = threading.Event()
    def tearDown(self):
        self.agent.db.close(); self.temp.cleanup()
    def action(self, name, args, rid=None):
        return self.agent.request(dict(method="action", request=dict(id=rid or identifier(), action={name:args})))
    def execute(self, name, args):
        return self.agent.execute(name, args, self.task, self.cancel, time.monotonic() + 5)
    def test_direct_chat_requires_actual_messaging_tool_before_completion(self):
        snapshot = self.action("chat", {"_0": "Say ready"})
        task = self.agent.state["tasks"][-1]
        self.agent.relay = Relay([
            [dict(type="text", delta="Private draft"), dict(type="completed", output=[])],
            [dict(type="completed", output=[call("messaging_typing", dict(active=True)), call("messaging_send", dict(text="Seven is ready."))])],
            [dict(type="completed", output=[])],
        ])
        self.agent.run(task, self.cancel)
        self.assertEqual(task["status"], "completed")
        self.assertEqual([m["text"] for m in self.agent.state["messages"] if m["role"] == "assistant"], ["Seven is ready."])
        self.assertEqual(len(self.agent.relay.requests), 3)
        self.assertIn("no delivered reply", self.agent.relay.requests[1]["input"][-1]["content"])
        self.assertEqual(self.agent.state["typing"], [])
    def test_direct_chat_missing_delivery_fails_after_one_repair_attempt(self):
        self.action("chat", {"_0": "Say ready"})
        task = self.agent.state["tasks"][-1]
        self.agent.relay = Relay([[dict(type="text", delta="Private draft"), dict(type="completed", output=[])] for _ in range(2)])
        self.agent.run(task, self.cancel)
        self.assertEqual(task["status"], "failed")
        self.assertIn("without delivering a chat reply", task["result"])
        self.assertEqual(len(self.agent.relay.requests), 2)
        self.assertFalse(any(m["role"] == "assistant" for m in self.agent.state["messages"]))
    def test_completed_multistep_memory_loop(self):
        self.agent.relay = Relay([
            [dict(type="completed", output=[call("memory_save", dict(title="Coffee", text="Prefer oat milk"))])],
            [dict(type="completed", output=[call("memory_search", dict(query="oat"))])],
            [dict(type="text", delta="Remembered."), dict(type="completed", output=[])],
        ])
        self.agent.run(self.task, self.cancel)
        self.assertEqual(self.task["status"], "completed")
        self.assertIn("oat milk", self.agent.state["journal"][1]["outcome"])
        self.assertEqual(len(self.agent.relay.requests), 3)
    def test_interrupted_stream_and_usage_error_never_complete(self):
        self.agent.relay = Relay([[dict(type="text", delta="Partial")]])
        self.agent.run(self.task, self.cancel)
        self.assertEqual(self.task["status"], "failed")
        self.assertIn("did not complete", self.task["result"])
        class Exhausted:
            def stream(self, *args): raise ValueError("Usage limit reached")
        self.agent.relay = Exhausted(); other = self.agent.task("Try")
        self.agent.run(other, threading.Event())
        self.assertEqual(other["status"], "failed")
        self.assertIn("Usage limit", other["result"])
    def test_files_and_symlink_escape(self):
        pid = self.agent.create_project("Project", "Build")
        self.execute("files_write", dict(projectID=pid, path="notes/a.txt", text="Keep this"))
        self.assertEqual(self.execute("files_read", dict(projectID=pid, path="notes/a.txt")), "Keep this")
        self.assertIn("notes/a.txt", self.execute("files_search", dict(projectID=pid, query="keep")))
        root = pathlib.Path(self.temp.name) / "Projects" / pid
        (root / "escape").symlink_to(pathlib.Path(self.temp.name))
        with self.assertRaisesRegex(ValueError, "escapes"): self.execute("files_read", dict(projectID=pid, path="escape/seven.sqlite"))
        with self.assertRaisesRegex(ValueError, "escapes"): self.execute("files_write", dict(projectID=pid, path="../../oops", text="oops"))
    def test_disabled_plugin_and_schema_rejected(self):
        self.agent.state["settings"]["enabledPlugins"].remove("memory")
        with self.assertRaisesRegex(ValueError, "disabled"): self.execute("memory_save", dict(title="A", text="B"))
        with self.assertRaisesRegex(ValueError, "arguments"): self.execute("commands_run", dict(command="true", extra=True))
        self.assertEqual(self.agent.state["journal"], [])
    def test_research_cannot_mutate_or_control_and_quiet_when_unchanged(self):
        self.task["researchOnly"] = True
        for name, args in [("commands_run", dict(command="true")), ("desktop_screenshot", dict(targetID=identifier())), ("schedules_create", dict(title="Later", prompt="Do", kind="task", nextRunUnix=time.time()))]:
            with self.assertRaisesRegex(ValueError, "Proactive research"): self.execute(name, args)
        self.assertNotIn("commands_run", [t["name"] for t in self.agent.tools(["commands"], True)])
        self.execute("memory_save", dict(title="Research", text="Useful"))
        self.agent.relay = Relay([[dict(type="completed", output=[])]])
        self.agent.run(self.task, self.cancel)
        self.assertEqual(self.agent.state["messages"], [])
    def test_exact_preapproval_and_handoff(self):
        rule = dict(id=identifier(), tool="memory_save", behavior="preapproved", approvedArguments=json.dumps(dict(title="Allowed", text="Yes")))
        self.agent.state["profile"]["rules"] = [rule]
        self.execute("memory_save", dict(title="Allowed", text="Yes"))
        self.assertEqual(self.agent.state["approvals"], [])
        rule["behavior"] = "handoff"
        with self.assertRaisesRegex(InterruptedError, "Handed off"): self.execute("memory_save", dict(title="Other", text="No"))
        self.assertEqual(len(self.agent.state["memory"]), 1)
    def test_changed_preapproval_requires_exact_confirmation(self):
        self.agent.state["profile"]["rules"] = [dict(id=identifier(), tool="memory_save", behavior="preapproved", approvedArguments='{"title":"One","text":"Yes"}')]
        results = []
        worker = threading.Thread(target=lambda: results.append(self.execute("memory_save", dict(title="Two", text="Yes"))))
        worker.start()
        end = time.monotonic() + 2
        while not self.agent.state["approvals"] and time.monotonic() < end: time.sleep(.01)
        approval = self.agent.state["approvals"][0]
        self.assertEqual(self.agent.state["memory"], [])
        self.action("approve", {"_0":approval["id"], "_1":True}); worker.join(2)
        self.assertFalse(worker.is_alive()); self.assertEqual(len(results), 1)
    def test_external_allow_still_needs_confirmation(self):
        self.agent.state["profile"]["rules"] = [dict(id=identifier(), tool="desktop_key", behavior="allow", approvedArguments="")]
        errors = []
        def run():
            try: self.execute("desktop_key", dict(targetID=identifier(), frameID=identifier(), key="enter"))
            except InterruptedError as error: errors.append(str(error))
        worker = threading.Thread(target=run); worker.start()
        end = time.monotonic() + 2
        while not self.agent.state["approvals"] and time.monotonic() < end: time.sleep(.01)
        self.assertEqual(self.agent.state["journal"], [])
        self.action("approve", {"_0":self.agent.state["approvals"][0]["id"], "_1":False}); worker.join(2)
        self.assertEqual(errors, ["Action declined"])
    def test_command_cancel_terminates_group_and_preserves_uncertainty(self):
        timer = threading.Timer(.15, self.cancel.set); timer.start(); start = time.monotonic()
        with self.assertRaises(InterruptedError): self.execute("commands_run", dict(command="sleep 10 & wait"))
        timer.join(); self.assertLess(time.monotonic()-start, 2)
        self.assertIsNone(self.agent.state["journal"][-1].get("outcome"))
    def test_request_dedup_survives_restart_and_active_run_needs_review(self):
        rid = identifier(); self.action("chat", {"_0":"Once"}, rid); self.action("chat", {"_0":"Once"}, rid)
        self.assertEqual(len(self.agent.state["messages"]), 1)
        self.task["status"] = "running"; self.agent.save(); self.agent.db.close()
        self.agent = ManualAgent(self.temp.name)
        self.action("chat", {"_0":"Once"}, rid)
        self.assertEqual(len(self.agent.state["messages"]), 1)
        self.assertEqual(self.agent.state["tasks"][0]["status"], "needsReview")
    def test_due_reminders_coalesce_persist_and_pause(self):
        s = dict(id=identifier(), title="Check in", prompt="Remember this", kind="reminder", nextRunAt=now()-10000, intervalSeconds=1800, enabled=True)
        self.action("saveSchedule", {"_0":s}); self.agent.proactive(); self.agent.proactive()
        self.assertEqual(len(self.agent.state["messages"]), 1)
        self.assertGreater(self.agent.state["schedules"][0]["nextRunAt"], now())
        self.agent.db.close(); self.agent = ManualAgent(self.temp.name); self.agent.proactive()
        self.assertEqual(len(self.agent.state["messages"]), 1)
        one = dict(s, id=identifier(), intervalSeconds=None, nextRunAt=now()-1)
        self.action("saveSchedule", {"_0":one}); self.action("pause", {"_0":True}); self.agent.proactive()
        self.assertEqual(len(self.agent.state["messages"]), 1)
        self.action("pause", {"_0":False}); self.agent.proactive()
        self.assertEqual(len(self.agent.state["messages"]), 2)
    def test_scheduled_task_and_responsibility_only_enqueue_once(self):
        self.action("saveSchedule", {"_0":dict(id=identifier(), title="Work", prompt="Do useful work", kind="task", nextRunAt=now()-1, enabled=True)})
        self.action("saveResponsibility", {"_0":dict(id=identifier(), title="Watch", instructions="Review notes", enabled=True)})
        self.agent.proactive(); self.agent.proactive()
        scheduled = [t for t in self.agent.state["tasks"] if t.get("scheduleID")]
        research = [t for t in self.agent.state["tasks"] if t.get("responsibilityID")]
        self.assertEqual(len(scheduled), 1); self.assertFalse(scheduled[0]["researchOnly"])
        self.assertEqual(len(research), 1); self.assertTrue(research[0]["researchOnly"])
    def test_profile_and_schedule_validation(self):
        p = copy.deepcopy(self.agent.state["profile"]); p["rules"] = [dict(id=identifier(), tool="memory_save", behavior="preapproved", approvedArguments="not JSON")]
        with self.assertRaises(ValueError): self.action("updateProfile", {"_0":p})
        with self.assertRaisesRegex(ValueError, "five minutes"): self.action("saveSchedule", {"_0":dict(id=identifier(), title="Spam", prompt="Do", kind="task", nextRunAt=now(), intervalSeconds=1, enabled=True)})
    def test_guidance_stops_original_and_enqueues_once(self):
        self.task["status"] = "waitingForApproval"
        approval = dict(id=identifier(), taskID=self.task["id"], tool="desktop_key", arguments="{}", createdAt=now())
        self.agent.state["approvals"].append(approval)
        rid = identifier()
        self.action("steerTask", {"_0":self.task["id"], "_1":"Use the other project"}, rid)
        self.action("steerTask", {"_0":self.task["id"], "_1":"Use the other project"}, rid)
        self.assertEqual(self.task["status"], "canceled"); self.assertFalse(approval["decision"])
        self.assertEqual(len(self.agent.state["tasks"]), 2)
        self.assertIn("reconcile", self.agent.state["tasks"][-1]["title"].lower())


if __name__ == "__main__": unittest.main()
