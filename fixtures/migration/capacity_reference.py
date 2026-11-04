"""Disposable SQLite capacity parity harness; never selects retained state."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from canaveral.store import Store
from canaveral.model import Error

value = json.load(sys.stdin)
store = Store(sys.argv[2], clock=lambda: 80000)
action = sys.argv[1]
if action == "initialize": result = {}
elif action == "save": result = store.save_resource_budget(value)
elif action == "validate":
    try:
        store.save_resource_budget(value)
        result = {"status": 200}
    except Error as error:
        result = {"status": error.status}
elif action == "list": result = store.resource_budgets()
elif action in ("used", "remaining"):
    with store.transaction() as db:
        operation = store._used if action == "used" else store._remaining_capacity
        result = operation(db, value["host"], exclude=value.get("exclude"))
else: raise ValueError("Unknown capacity fixture action")
print(json.dumps(result))
