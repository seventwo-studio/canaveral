import json
import pathlib
import tempfile
import threading
import time
import unittest
from seven_agent import Agent, identifier

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.agent = Agent(self.folder.name, worker_only=True)
        self.project = identifier(); self.task = identifier()
    def tearDown(self):
        self.agent.request(dict(method="shutdown")); self.agent.db.close(); self.folder.cleanup()
    def call(self, name, arguments, invocation=None):
        return self.agent.request(dict(method="workerTool", name=name, arguments=arguments, taskID=self.task,
                                       invocationID=invocation or identifier(), projects=[dict(id=self.project, name="Fixture")]))
    def test_worker_has_no_autonomous_inference_or_chat(self):
        self.agent.proactive(); self.agent.schedule()
        self.assertIsNone(self.agent.worker)
        with self.assertRaisesRegex(ValueError, "no autonomous"):
            self.agent.request(dict(method="action", request=dict(id=identifier(), action=dict(chat={"_0":"Do work"}))))
        for name in ("hostCommand", "messaging_send", "agents_delegate", "memory_save", "desktop_key"):
            with self.assertRaisesRegex(ValueError, "Unknown worker"):
                self.call(name, {})
    def test_file_tools_are_in_guest_project_and_reject_escape(self):
        args = dict(projectID=self.project, path="notes/check.txt", text="stored inside guest")
        self.call("files_write", args)
        result = self.call("files_read", dict(projectID=self.project, path="notes/check.txt"))
        self.assertEqual(result["result"], "stored inside guest")
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.call("files_read", dict(projectID=self.project, path="../../outside.txt"))
        self.assertIn("runtimeVersion", result)
    def test_command_retries_return_receipt_without_reexecution(self):
        invocation = identifier(); args = dict(command="printf x >> counter.txt; cat counter.txt", projectID=self.project)
        first = self.call("commands_run", args, invocation)
        second = self.call("commands_run", args, invocation)
        self.assertEqual(first, second)
        self.assertEqual((pathlib.Path(self.folder.name)/"Projects"/self.project/"counter.txt").read_text(), "x")
        with self.assertRaisesRegex(ValueError, "different arguments"):
            self.call("commands_run", dict(command="true"), invocation)
    def test_cancel_kills_command_and_prevents_late_dispatch(self):
        errors = []
        def command():
            try: self.call("commands_run", dict(command="sleep 30"))
            except Exception as error: errors.append(error)
        worker = threading.Thread(target=command); worker.start()
        end = time.monotonic()+3
        while not self.agent.worker_cancels and time.monotonic()<end: time.sleep(0.01)
        self.agent.request(dict(method="workerCancel", taskID=self.task)); worker.join(3)
        self.assertFalse(worker.is_alive()); self.assertIsInstance(errors[0], InterruptedError)
        with self.assertRaises(InterruptedError): self.call("commands_run", dict(command="true"))
        self.assertIsNone(self.agent.state["journal"][-1].get("outcome"))
    def test_network_and_uncertain_replay_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "networking"):
            self.call("commands_run", dict(command="true", network=True))
        invocation = identifier(); args = dict(command="true")
        self.agent.state["journal"].append(dict(id=identifier(), taskID=self.task, invocationID=invocation,
                                              tool="commands_run", arguments=json.dumps(args)))
        self.agent.save()
        with self.assertRaisesRegex(InterruptedError, "Uncertain"):
            self.call("commands_run", args, invocation)
    def test_legacy_history_export_preserves_processed_request_ids(self):
        self.agent.state["processedRequests"] = [identifier()]; self.agent.save()
        snapshot = self.agent.request(dict(method="snapshot"))
        history = self.agent.request(dict(method="guestHistory"))
        self.assertEqual(snapshot["processedRequests"], [])
        self.assertEqual(history["processedRequests"], self.agent.state["processedRequests"])

if __name__ == "__main__": unittest.main()
