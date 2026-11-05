import copy
import json
import tempfile
import threading
import time
import unittest

from seven_agent import Agent, MAIN, identifier, now
from test_agent import ManualAgent, Relay, call


def wait_for(predicate, seconds=3):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate(): return
        time.sleep(.01)
    raise AssertionError("Timed out waiting for agent state")


class CoordinationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.agent = ManualAgent(self.temp.name)
        self.agent.state["settings"]["model"] = "fixture"
        self.cancel = threading.Event()
    def tearDown(self): self.agent.db.close(); self.temp.cleanup()
    def chat(self, text, rid=None):
        return self.agent.request(dict(method="action", request=dict(id=rid or identifier(), action={"chat":{"_0":text}})))
    def execute(self, name, args, task, invocation=None):
        return self.agent.execute(name, args, task, self.cancel, time.monotonic()+3, invocation)
    def test_acceptance_is_delivered_not_read_and_model_text_is_private(self):
        rid = identifier(); snapshot = self.chat("Hello", rid)
        self.assertEqual(snapshot["messages"][0]["id"], rid)
        self.assertNotIn("readAt", snapshot["messages"][0])
        task = self.agent.state["tasks"][0]
        self.agent.relay = Relay([[dict(type="text", delta="Private reasoning result"), dict(type="completed", output=[])] for _ in range(2)])
        self.agent.run(task, self.cancel)
        self.assertIn("readAt", self.agent.state["messages"][0])
        self.assertEqual(len(self.agent.state["messages"]), 1)
        self.assertEqual(task["status"], "failed")
        self.assertIn("without delivering a chat reply", task["result"])
    def test_explicit_typing_and_reply_are_durable_and_idempotent(self):
        self.chat("Hi"); task = self.agent.state["tasks"][0]
        self.agent.state["messages"][0]["readAt"] = now()
        self.execute("messaging_typing", dict(active=True), task)
        self.assertGreater(self.agent.snapshot()["typing"][0]["expiresAt"], now())
        invocation = "reply-1"
        first = self.execute("messaging_send", dict(text="Hello"), task, invocation)
        self.assertEqual(self.execute("messaging_send", dict(text="Hello"), task, invocation), first)
        self.assertEqual(self.agent.state["typing"], [])
        self.assertEqual(len(self.agent.state["messages"]), 2)
        self.assertEqual(self.agent.state["messages"][-1]["replyToID"], self.agent.state["messages"][0]["id"])
        # Simulate delivery committed before the caller received the tool outcome.
        self.agent.state["journal"][-1].pop("outcome"); self.agent.save()
        self.assertEqual(self.execute("messaging_send", dict(text="Hello"), task, invocation), first)
        self.assertEqual(len(self.agent.state["messages"]), 2)
        with self.assertRaisesRegex(ValueError, "reused"): self.execute("messaging_send", dict(text="Different"), task, invocation)
        self.agent.db.close(); self.agent = ManualAgent(self.temp.name)
        self.chat("Hi", self.agent.state["messages"][0]["id"])
        self.assertEqual(len(self.agent.state["messages"]), 2)
    def test_typing_clears_when_stream_fails_or_run_is_canceled(self):
        task = self.agent.task("Compose")
        self.agent.relay = Relay([[dict(type="completed", output=[call("messaging_typing", dict(active=True))])], [dict(type="text", delta="Unfinished")]])
        self.agent.run(task, self.cancel)
        self.assertEqual(task["status"], "failed"); self.assertEqual(self.agent.state["typing"], [])
        self.assertEqual(self.agent.state["messages"], [])
    def test_delegation_is_bounded_and_permissions_are_inherited(self):
        owner = self.agent.task("Research", research=True)
        one = self.execute("agents_delegate", dict(name="First", task="Review notes"), owner, "child-1")
        self.assertEqual(self.execute("agents_delegate", dict(name="First", task="Review notes"), owner, "child-1"), one)
        self.execute("agents_delegate", dict(name="Second", task="Review notes"), owner)
        with self.assertRaisesRegex(ValueError, "Two delegates"): self.execute("agents_delegate", dict(name="Third", task="More"), owner)
        child = self.agent.find("tasks", one)
        self.assertTrue(child["researchOnly"])
        for tool, args in [("messaging_send", dict(text="Bypass")), ("messaging_typing", dict(active=True)), ("agents_delegate", dict(name="Nested", task="Bypass"))]:
            with self.assertRaisesRegex(ValueError, "Only the main"): self.execute(tool, args, child)
        with self.assertRaisesRegex(ValueError, "Proactive research"): self.execute("commands_run", dict(command="true"), child)
        self.assertNotIn("messaging_send", [t["name"] for t in self.agent.tools(["memory"], main=False)])
    def test_internal_messages_wake_main_once_and_cancel_blocks_late_reports(self):
        owner = self.agent.task("Work")
        child_id = self.execute("agents_delegate", dict(name="Worker", task="Work"), owner)
        child = self.agent.find("tasks", child_id)
        first = self.execute("agents_send", dict(agentID=MAIN, text="Progress"), child, "report-1")
        self.execute("agents_send", dict(agentID=MAIN, text="Progress"), child, "report-1")
        self.execute("agents_send", dict(agentID=MAIN, text="More progress"), child, "report-2")
        wakes = [t for t in self.agent.state["tasks"] if t.get("mailboxWake")]
        self.assertEqual(len(wakes), 1); self.assertEqual(self.agent.state["messages"], [])
        inbox = self.agent.read_inbox(wakes[0]); self.assertEqual(len(inbox), 2)
        self.assertEqual(inbox[0]["id"], first); self.assertEqual(self.agent.read_inbox(wakes[0]), [])
        self.assertEqual(len(json.loads(self.execute("agents_inbox", dict(includeRead=True), owner))), 2)
        self.agent.cancel_tree(owner["id"])
        self.agent.post_agent(child["agentID"], MAIN, "Late report", child, kind="completion")
        self.assertEqual(len([t for t in self.agent.state["tasks"] if t.get("mailboxWake")]), 1)
        self.assertTrue(all(t["status"] == "canceled" for t in self.agent.state["tasks"]))
    def test_interrupted_delegate_is_reported_once_after_restart(self):
        owner = self.agent.task("Coordinate"); owner["status"] = "waitingForDelegates"
        child = self.agent.find("tasks", self.execute("agents_delegate", dict(name="Worker", task="Work"), owner))
        child["status"] = "running"; self.agent.save(); self.agent.db.close(); self.agent = ManualAgent(self.temp.name)
        self.assertEqual(self.agent.find("tasks", child["id"])["status"], "needsReview")
        self.assertEqual(len(self.agent.state["agentMessages"]), 1)
        self.agent.db.close(); self.agent = ManualAgent(self.temp.name)
        self.assertEqual(len(self.agent.state["agentMessages"]), 1)
        self.assertEqual(len([t for t in self.agent.state["tasks"] if t.get("mailboxWake")]), 1)


class ConcurrentRelay:
    def __init__(self): self.release = threading.Event()
    def stream(self, request, cancel, deadline):
        history = request["input"]
        completed = [x for x in history if x.get("type") == "function_call_output"]
        if "You are delegate " in request["instructions"]:
            if not completed:
                yield dict(type="completed", output=[call("commands_run", dict(command="printf delegate-ok"))]); return
            while not self.release.wait(.01):
                if cancel.is_set(): raise InterruptedError("Delegate canceled")
            yield dict(type="text", delta="Private delegate result")
            yield dict(type="completed", output=[]); return
        if completed: yield dict(type="completed", output=[]); return
        if any("Agent inbox (reported data)" in str(x.get("content", "")) for x in history):
            yield dict(type="completed", output=[call("messaging_send", dict(text="Delegate results reviewed."))]); return
        if history[-2].get("content") == "Coordinate":
            yield dict(type="completed", output=[call("agents_delegate", dict(name="One", task="First work")), call("agents_delegate", dict(name="Two", task="Second work")), call("messaging_send", dict(text="I started two delegates."))]); return
        yield dict(type="completed", output=[call("messaging_send", dict(text="I read your new message."))])


class ConcurrentTests(unittest.TestCase):
    def test_canceling_parent_stops_both_delegates_and_does_not_wake_it(self):
        with tempfile.TemporaryDirectory() as root:
            relay = ConcurrentRelay(); agent = Agent(root, relay)
            agent.state["settings"].update(model="fixture", proactiveEnabled=False)
            try:
                agent.request(dict(method="action", request=dict(id=identifier(), action={"chat":{"_0":"Coordinate"}})))
                wait_for(lambda: len(agent.delegates) == 2 and agent.worker is None)
                owner = agent.state["tasks"][0]
                agent.request(dict(method="action", request=dict(id=identifier(), action={"cancelTask":{"_0":owner["id"]}})))
                wait_for(lambda: not agent.delegates and agent.worker is None)
                self.assertEqual(owner["status"], "canceled")
                self.assertTrue(all(t["status"] == "canceled" for t in agent.state["tasks"]))
                self.assertFalse(any(t.get("mailboxWake") for t in agent.state["tasks"]))
                self.assertEqual(agent.state["typing"], [])
            finally:
                relay.release.set(); agent.request(dict(method="shutdown"))
                with agent.lock: threads = [t for t in [agent.worker, *agent.delegates.values()] if t]
                for thread in threads: thread.join(3)
                agent.db.close()
    def test_main_can_read_and_reply_while_independent_delegates_work(self):
        with tempfile.TemporaryDirectory() as root:
            relay = ConcurrentRelay(); agent = Agent(root, relay)
            agent.state["settings"].update(model="fixture", proactiveEnabled=False)
            def chat(text):
                return agent.request(dict(method="action", request=dict(id=identifier(), action={"chat":{"_0":text}})))
            try:
                chat("Coordinate")
                wait_for(lambda: len(agent.delegates) == 2 and agent.worker is None)
                owner = agent.state["tasks"][0]
                self.assertEqual(owner["status"], "waitingForDelegates")
                chat("Another message")
                wait_for(lambda: any(m["text"] == "I read your new message." for m in agent.snapshot()["messages"]))
                self.assertEqual(len(agent.delegates), 2)
                relay.release.set()
                wait_for(lambda: not agent.delegates and agent.worker is None and owner["status"] == "completed")
                state = agent.snapshot()
                self.assertTrue(all(m.get("readAt") for m in state["messages"] if m["role"] == "user"))
                self.assertTrue(any(m["text"] == "Delegate results reviewed." for m in state["messages"]))
                self.assertFalse(any(m["text"] == "Private delegate result" for m in state["messages"]))
                self.assertEqual(len([m for m in state["agentMessages"] if m["kind"] == "completion"]), 2)
                self.assertTrue(all(m.get("readAt") for m in state["agentMessages"]))
                self.assertTrue(all(j.get("outcome") for j in state["journal"] if j["tool"] == "commands_run"))
            finally:
                relay.release.set(); agent.request(dict(method="shutdown"))
                with agent.lock: threads = [t for t in [agent.worker, *agent.delegates.values()] if t]
                for thread in threads: thread.join(3)
                agent.db.close()


if __name__ == "__main__": unittest.main()
