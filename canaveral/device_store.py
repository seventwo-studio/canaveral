"""Durable FIFO device operations delivered through authenticated host heartbeats."""
import json

from .devices import MAX_RESULT, TERMINAL, operation_request
from .model import Error, identifier


class DeviceStore:
    def _operation(self, row):
        result = {"id": row["id"], "machineId": row["machine"], "hostId": row["host"],
                  "state": row["state"], "updatedAt": row["updated"]}
        if row["result"]:
            result["result"] = json.loads(row["result"])
        return result

    def device_operation(self, operation_id):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM device_operations WHERE id=?", (identifier(operation_id),)).fetchone()
            if not row:
                raise Error("Unknown device operation.", 404)
            return self._operation(row)

    def create_device_operation(self, machine_id, value):
        machine_id, request = identifier(machine_id), operation_request(value)
        with self.transaction() as db:
            old = db.execute("SELECT * FROM device_operations WHERE id=?", (request["id"],)).fetchone()
            if old:
                if old["machine"] != machine_id or json.loads(old["request"]) != request:
                    raise Error("Request identity already belongs to another device operation.")
                return self._operation(old)
            row = db.execute("SELECT m.*,h.seen FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?", (machine_id,)).fetchone()
            if not row:
                raise Error("Unknown machine.", 404)
            image = json.loads(row["template"])
            system = image["os"]
            if system not in ("android", "ios") and not image.get("guestAccess"):
                raise Error("This machine is not a mobile device.")
            if system == "ios" and request["action"].startswith("shell"):
                raise Error("Guest shell is Android-only.", 400)
            if row["desired"] != "running" or row["observed"] != "running" or self.clock() - row["seen"] >= self.lease_seconds:
                raise Error("Device must be running on an online host.")
            if db.execute("SELECT count(*) FROM device_operations WHERE host=? AND state='queued'", (row["host"],)).fetchone()[0] >= 32:
                raise Error("Host device operation queue is full.", 429)
            db.execute("INSERT INTO device_operations VALUES (?,?,?,?,?,?,?,?)",
                       (request["id"], machine_id, row["host"], json.dumps(request), "queued", None, self.clock(), self.clock()))
            return self._operation(db.execute("SELECT * FROM device_operations WHERE id=?", (request["id"],)).fetchone())

    def _report_device_operations(self, db, host_id, reports):
        if not isinstance(reports, dict) or len(reports) > 1:
            raise Error("Report at most one device operation per heartbeat.", 400)
        for operation_id, report in reports.items():
            row = db.execute("SELECT * FROM device_operations WHERE id=?", (identifier(operation_id),)).fetchone()
            if not row or row["host"] != host_id:
                raise Error("Cannot report another host's device operation.", 403)
            if not isinstance(report, dict) or set(report) - {"state", "result"} or report.get("state") not in TERMINAL:
                raise Error("Invalid device operation report.", 400)
            encoded = json.dumps(report.get("result", {}), allow_nan=False)
            if len(encoded.encode()) > MAX_RESULT:
                raise Error("Device result exceeds 6 MiB.", 413)
            if row["state"] in TERMINAL:
                continue  # First receipt wins, including an uncertain outcome.
            db.execute("UPDATE device_operations SET state=?,result=?,updated=? WHERE id=?",
                       (report["state"], encoded, self.clock(), operation_id))

    def _assigned_device_operations(self, db, host_id):
        # Bound assignment bodies too: file chunks can approach the normal API body limit.
        row = db.execute("SELECT * FROM device_operations WHERE host=? AND state='queued' ORDER BY rowid LIMIT 1", (host_id,)).fetchone()
        if not row:
            return []
        scoped = db.execute('SELECT c.*,l.expires FROM consumer_operations c JOIN leases l ON l.id=c.lease WHERE c.id=?', (row['id'],)).fetchone()
        extra = {}
        if scoped:
            db.execute('UPDATE consumer_operations SET dispatched=1 WHERE id=?', (row['id'],))
            extra = {'leaseId': scoped['lease']}
        return [{**json.loads(row["request"]), "machineId": row["machine"],
                 "expiresAt": min(row["created"] + 120, scoped['expires']) if scoped else row["created"] + 120, **extra}]
