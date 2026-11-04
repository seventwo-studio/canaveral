"""Inference placements share the VM store's transaction and capacity ledger."""
import json

from .inference import STATES, TERMINAL, generation_result, job_request
from .model import Error, identifier


class InferenceStore:
    def models(self):
        return [{**model, "hostId": host["id"], "online": host["online"], "accepting": host["enabled"]}
                for host in self.hosts() for model in host.get("inference", {}).get("models", [])]

    def _job(self, row, online=True, assignment=False):
        request = json.loads(row["request"])
        result = {"id": row["id"], "hostId": row["host"], "model": request["model"],
                  "definition": json.loads(row["definition"]), "desired": row["desired"],
                  "state": row["state"] if online or row["state"] in TERMINAL else "unknown",
                  "detail": row["detail"], "updatedAt": row["updated"]}
        if assignment:
            result["request"] = request
        elif row["result"]:
            result["result"] = json.loads(row["result"])
        return result

    def jobs(self, job_id=None):
        with self.transaction() as db:
            if job_id:
                rows = db.execute("SELECT j.*,h.seen FROM inference_jobs j JOIN hosts h ON h.id=j.host WHERE j.id=?", (job_id,)).fetchall()
            else:
                # Keep inventory bounded without fetching large historical result bodies.
                rows = db.execute("SELECT j.id,j.request,j.host,j.definition,j.desired,j.state,j.detail,NULL AS result,j.updated,h.seen "
                                  "FROM inference_jobs j JOIN hosts h ON h.id=j.host ORDER BY j.rowid DESC LIMIT 100").fetchall()
            if job_id and not rows:
                raise Error("Unknown inference job.", 404)
            result = [self._job(row, self.clock() - row["seen"] < self.lease_seconds) for row in rows]
            if job_id:
                return result[0]
            return result

    def _assigned_jobs(self, db, host_id):
        return [self._job(row, assignment=True) for row in db.execute(
            "SELECT * FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled') ORDER BY rowid", (host_id,))]

    def create_job(self, value):
        request = job_request(value)
        with self.transaction() as db:
            old = db.execute("SELECT j.*,h.seen FROM inference_jobs j JOIN hosts h ON h.id=j.host WHERE j.id=?", (request["id"],)).fetchone()
            if old:
                if json.loads(old["request"]) != request:
                    raise Error("Request identity is already used for another inference specification.")
                return self._job(old, self.clock() - old["seen"] < self.lease_seconds)
            candidates = []
            for host in db.execute("SELECT * FROM hosts WHERE enabled=1 ORDER BY id"):
                if self.clock() - host["seen"] >= self.lease_seconds or request.get("hostId", host["id"]) != host["id"]:
                    continue
                advertised = json.loads(host["offer"])
                used = self._used(db, host["id"])
                remaining = self._remaining_capacity(db,host['id'])
                if db.execute("SELECT count(*) FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')", (host["id"],)).fetchone()[0] >= 32:
                    continue
                for model in advertised.get("inference", {}).get("models", []):
                    if model["id"] != request["model"] or request.get("digest", model["digest"]) != model["digest"]:
                        continue
                    if all(model['resources'][key] <= remaining[key] for key in used):
                        candidates.append((used["memoryMiB"] / advertised["capacity"]["memoryMiB"], host["id"], model))
            if not candidates:
                raise Error("No online accepting host offers this model and enough unreserved capacity.")
            if "digest" not in request and len({item[2]["digest"] for item in candidates}) > 1:
                raise Error("Multiple model digests are available; choose digest explicitly.")
            _, host_id, model = min(candidates, key=lambda item: (item[0], item[1]))
            db.execute("INSERT INTO inference_jobs VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (request["id"], json.dumps(request), host_id, json.dumps(model), "running", "queued", "", None, self.clock(), self.clock()))
            return self._job(db.execute("SELECT * FROM inference_jobs WHERE id=?", (request["id"],)).fetchone())

    def cancel_job(self, job_id):
        job_id = identifier(job_id)
        with self.transaction() as db:
            row = db.execute("SELECT * FROM inference_jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise Error("Unknown inference job.", 404)
            if row["state"] not in TERMINAL:
                db.execute("UPDATE inference_jobs SET desired='cancelled' WHERE id=?", (job_id,))
        return self.jobs(job_id)

    def _report_jobs(self, db, host_id, reports):
        if not isinstance(reports, dict) or len(reports) > 32:
            raise Error("Invalid inference reports.", 400)
        for job_id, report in reports.items():
            row = db.execute("SELECT * FROM inference_jobs WHERE id=?", (identifier(job_id),)).fetchone()
            if not row or row["host"] != host_id:
                raise Error("Cannot report inference assigned to another host.", 403)
            if not isinstance(report, dict) or report.get("state") not in STATES:
                raise Error("Invalid inference state.", 400)
            detail = report.get("detail", "")
            if not isinstance(detail, str) or len(detail) > 2000:
                raise Error("Invalid inference detail.", 400)
            result = generation_result(report.get("result"), json.loads(row["request"])["model"]) if report["state"] == "succeeded" else None
            if row["state"] in TERMINAL:
                if report["state"] != row["state"] or result != (json.loads(row["result"]) if row["result"] else None):
                    raise Error("A terminal inference outcome cannot be replaced.")
                continue
            db.execute("UPDATE inference_jobs SET state=?,detail=?,result=?,updated=? WHERE id=?",
                       (report["state"], detail, json.dumps(result) if result is not None else None, self.clock(), job_id))

    def _inference_used(self, db, host_id):
        used = {"cpu": 0, "memoryMiB": 0, "diskGiB": 0}
        for row in db.execute("SELECT definition FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')", (host_id,)):
            size = json.loads(row["definition"])["resources"]
            for key in used:
                used[key] += size[key]
        return used
