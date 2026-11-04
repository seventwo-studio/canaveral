"""Verify shared Rust traces against unchanged Python, using disposable state."""
import copy
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from canaveral.lease_guard import LeaseGuard

fixture = json.loads(Path(__file__).with_name("lease_guard.json").read_text())
for case in fixture["cases"]:
    with tempfile.TemporaryDirectory(prefix="canaveral-python-guard-parity-") as state:
        now = {"wall": 1000.0, "mono": 10.0}
        if case.get("identity"): Path(state, "identity.json").write_text("{}")
        def opened(): return LeaseGuard(state, clock=lambda: now["wall"], monotonic=lambda: now["mono"])
        guard = opened()
        for step in case["steps"]:
            now.update(wall=step.get("wall", 1000.0), mono=step.get("mono", 10.0))
            machine = copy.deepcopy(fixture["machine"])
            machine["lease"].update(step.get("lease", {}))
            mid, lid = machine["id"], fixture["machine"]["lease"]["id"]
            try:
                op = step["op"]
                if op == "observe": result = guard.observe([machine], step.get("rtt", 0.0))
                elif op == "empty": result = guard.observe([], 0.0)
                elif op == "allowed": result = guard.allowed(mid)
                elif op == "never_started": result = guard.never_started(mid, lid)
                elif op == "authorization": result = guard.authorization(mid, lid)
                elif op == "begin": result = guard.begin_execution(mid, lid)
                elif op == "retire": result = guard.retire(mid, lid, machine["leaseCleanup"]["id"])
                elif op == "assignments": result = guard.assignments([machine])
                elif op == "fenced": result = sorted(guard.fenced_machines())
                elif op == "reopen": guard = opened(); result = None
                else: raise AssertionError(op)
            except Exception:
                if not step.get("error"): raise
            else:
                assert not step.get("error"), (case["name"], step)
                assert result == step.get("expected"), (case["name"], step, result)
        if case.get("wire"):
            expected = {**fixture["initialRecord"], "machine": fixture["machine"]}
            assert json.loads(Path(state, "lease-execution.json").read_text()) == {fixture["machine"]["id"]: expected}
print(f"Verified {len(fixture['cases'])} lease guard traces against Python reference.")
