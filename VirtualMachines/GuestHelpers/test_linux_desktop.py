import pathlib
import tempfile
import time
import unittest
import uuid
from linux_desktop import Bridge, REFERENCE_EPOCH


class FixtureDesktop:
    def __init__(self):
        self.calls = 0
        self.fail = False

    def capture(self):
        return {"id": str(uuid.uuid4()), "capturedAt": time.time() - REFERENCE_EPOCH}

    def perform(self, action):
        self.calls += 1
        if self.fail:
            raise RuntimeError("Interrupted after input might have been posted")


class GuestRecoveryTests(unittest.TestCase):
    def test_acknowledged_input_is_deduplicated_across_restart(self):
        with tempfile.TemporaryDirectory() as path:
            guest = FixtureDesktop()
            bridge = Bridge(guest, "fixture", pathlib.Path(path))
            frame = bridge.request("/v1/desktop")
            action = {"id": str(uuid.uuid4()), "frameID": frame["id"], "kind": "key", "key": "return"}
            self.assertEqual(bridge.request("/v1/desktop/action", action)["status"], "posted")
            reopened = Bridge(guest, "fixture", pathlib.Path(path))
            self.assertEqual(reopened.request("/v1/desktop/action", action)["status"], "posted")
            self.assertEqual(guest.calls, 1)

    def test_uncertain_input_cannot_be_replayed(self):
        with tempfile.TemporaryDirectory() as path:
            guest = FixtureDesktop(); guest.fail = True
            bridge = Bridge(guest, "fixture", pathlib.Path(path))
            frame = bridge.request("/v1/desktop")
            action = {"id": str(uuid.uuid4()), "frameID": frame["id"], "kind": "click", "x": 0.5, "y": 0.5}
            with self.assertRaises(RuntimeError): bridge.request("/v1/desktop/action", action)
            reopened = Bridge(guest, "fixture", pathlib.Path(path))
            with self.assertRaises(ValueError): reopened.request("/v1/desktop/action", action)
            self.assertEqual(guest.calls, 1)

    def test_stale_frames_and_wrong_endpoints_do_not_post_input(self):
        with tempfile.TemporaryDirectory() as path:
            guest = FixtureDesktop(); bridge = Bridge(guest, "fixture", pathlib.Path(path))
            frame = bridge.request("/v1/desktop"); bridge.frames[frame["id"]] -= 181
            action = {"id": str(uuid.uuid4()), "frameID": frame["id"], "kind": "key", "key": "return"}
            with self.assertRaises(ValueError): bridge.request("/v1/desktop/action", action)
            with self.assertRaises(ValueError): bridge.request("/host/shell", action)
            self.assertEqual(guest.calls, 0)

    def test_takeover_blocks_ai_survives_restart_and_requires_explicit_return(self):
        with tempfile.TemporaryDirectory() as path:
            guest = FixtureDesktop(); root = pathlib.Path(path)
            bridge = Bridge(guest, "fixture", root)
            bridge.request("/v1/desktop/control", {"userControl": True})
            reopened = Bridge(guest, "fixture", root)
            session = reopened.request("/v1/desktop/session")
            self.assertTrue(session["userControl"])
            action = {"id": str(uuid.uuid4()), "frameID": session["frame"]["id"], "kind": "key", "key": "return"}
            with self.assertRaises(ValueError): reopened.request("/v1/desktop/action", action)
            action["human"] = True
            self.assertEqual(reopened.request("/v1/desktop/action", action)["status"], "posted")
            frame = reopened.request("/v1/desktop")
            reopened.request("/v1/desktop/control", {"userControl": False})
            stale = {"id": str(uuid.uuid4()), "frameID": frame["id"], "kind": "key", "key": "return"}
            with self.assertRaises(ValueError): reopened.request("/v1/desktop/action", stale)
            self.assertFalse(Bridge(guest, "fixture", root).request("/v1/desktop/session")["userControl"])
            self.assertEqual(guest.calls, 1)

    def test_viewing_preserves_recent_ai_frames(self):
        with tempfile.TemporaryDirectory() as path:
            guest = FixtureDesktop(); bridge = Bridge(guest, "fixture", pathlib.Path(path))
            frame = bridge.request("/v1/desktop")
            bridge.request("/v1/desktop/session")
            action = {"id": str(uuid.uuid4()), "frameID": frame["id"], "kind": "key", "key": "return"}
            self.assertEqual(bridge.request("/v1/desktop/action", action)["status"], "posted")


if __name__ == "__main__": unittest.main()
