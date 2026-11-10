import contextlib
import json
import os
import secrets
import re
import sqlite3
import time

from .model import Error, digest, identifier, machine_request, offer, secret
from .lease_eligibility import lease_eligible
from .inference_store import InferenceStore
from .device_store import DeviceStore
from .infrastructure import InfrastructureStore
from .image_store import ImageStore
from .consumers import ConsumerStore
from .lease_store import LeaseStore
from .registry_store import RegistryStore
from .power_store import PowerStore
from .deletion_store import DeletionStore
from .access_sessions import AccessSessionStore
from .lease_cleanup_store import LeaseCleanupStore


from .consumer_operations import ConsumerOperationStore


class Store(ConsumerOperationStore, InferenceStore, DeviceStore, InfrastructureStore, ImageStore, ConsumerStore, LeaseStore, RegistryStore, PowerStore, DeletionStore, AccessSessionStore, LeaseCleanupStore):
    """Transactions reserve capacity before returning a placement to any worker."""
    def __init__(self, path, lease_seconds=30, clock=time.time):
        self.path, self.lease_seconds, self.clock = str(path), lease_seconds, clock
        self._leases_ready=False
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, mode=0o700, exist_ok=True)
        with self.transaction() as db:
            self.initialize_infrastructure(db)
            self.initialize_images(db)
            self.initialize_consumers(db)
            self.initialize_leases(db)
            self.initialize_lease_cleanup(db)
            self.initialize_power(db)
            self.initialize_deletions(db)
            self.initialize_access_sessions(db)
            self.initialize_consumer_operations(db)
            db.execute("CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, credential TEXT NOT NULL, offer TEXT NOT NULL, seen REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)")
            db.execute("CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, request TEXT NOT NULL, host TEXT NOT NULL, template TEXT NOT NULL, desired TEXT NOT NULL, observed TEXT NOT NULL, detail TEXT NOT NULL, updated REAL NOT NULL)")
            columns = {row[1] for row in db.execute("PRAGMA table_info(machines)")}
            for name, definition in {"owner": "TEXT", "intent": "TEXT", "preparation_hash": "TEXT", "prepared_at": "REAL NOT NULL DEFAULT 0", "preparation_state": "TEXT NOT NULL DEFAULT 'pending'",'access_ready':'INTEGER'}.items():
                if name not in columns:
                    db.execute("ALTER TABLE machines ADD COLUMN " + name + " " + definition)
            db.execute("UPDATE machines SET intent=request WHERE intent IS NULL")
            db.execute("CREATE TABLE IF NOT EXISTS templates (id TEXT NOT NULL,revision TEXT NOT NULL,arch TEXT NOT NULL,definition TEXT NOT NULL,PRIMARY KEY (id,revision,arch))")
            db.execute("CREATE TABLE IF NOT EXISTS inference_jobs (id TEXT PRIMARY KEY, request TEXT NOT NULL, host TEXT NOT NULL, definition TEXT NOT NULL, desired TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, result TEXT, updated REAL NOT NULL, created REAL NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS inference_jobs_host_state ON inference_jobs (host,state)")
            db.execute("CREATE TABLE IF NOT EXISTS device_operations (id TEXT PRIMARY KEY,machine TEXT NOT NULL,host TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated REAL NOT NULL,created REAL NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS device_operations_host_state ON device_operations (host,state)")
            for row in db.execute("SELECT id,offer FROM hosts").fetchall():
                advertised=offer(json.loads(row['offer']))
                self._register_templates(db, advertised)
                db.execute('INSERT OR IGNORE INTO host_limits VALUES (?,?)',(row['id'],json.dumps(advertised['capacity'])))
        os.chmod(self.path, 0o600)
        self._leases_ready=True
        with self.transaction():pass # Persist expiry before serving after restart.

    @contextlib.contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            if self._leases_ready:
                self._refresh_leases(db)
                self._refresh_access_sessions(db)
                self._close_consumer_operations(db)
            from .authorization import current
            policy = current.get()
            if policy is not None:
                policy.check(db)
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def enroll(self, value, setup_token=None):
        host_id = identifier(value.get("id"))
        credential = digest(secret(value.get("credential")))
        proposed = offer(value.get("offer"))
        with self.transaction() as db:
            if setup_token is not None:
                self._claim_setup(db, setup_token, host_id, proposed)
            old = db.execute("SELECT credential FROM hosts WHERE id=?", (host_id,)).fetchone()
            if old:
                if not secrets.compare_digest(old[0], credential):
                    raise Error("Host identity already exists with a different credential.", 403)
                return {"id": host_id}
            self._validate_catalogue_offer(db,host_id,proposed)
            self._register_templates(db, proposed)
            db.execute("INSERT INTO hosts VALUES (?,?,?,?,1)", (host_id, credential, json.dumps(proposed), self.clock()))
            db.execute('INSERT INTO host_limits VALUES (?,?)',(host_id,json.dumps(proposed['capacity'])))
        return {"id": host_id}

    def _register_templates(self, db, proposed):
        for image in proposed["templates"]:
            key = (image["id"], image["revision"], image["arch"])
            previous = db.execute("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?", key).fetchone()
            if previous and json.loads(previous[0]) != image:
                raise Error("Template identity/revision already has a different definition. Publish a new revision.")
            if not previous:
                db.execute("INSERT INTO templates VALUES (?,?,?,?)", (*key, json.dumps(image)))

    def _authenticate(self, db, host_id, credential):
        if db.execute('SELECT 1 FROM retired_runners WHERE id=?',(host_id,)).fetchone():
            raise Error('This runtime identity was retired into its physical host.',403)
        host = db.execute("SELECT * FROM hosts WHERE id=?", (identifier(host_id),)).fetchone()
        if not host or not secrets.compare_digest(host["credential"], digest(credential)):
            raise Error("Host credential rejected.", 401)
        return host

    def authenticate_host(self, host_id, credential):
        with self.transaction() as db:
            self._authenticate(db, host_id, credential)

    def heartbeat(self, host_id, credential, value):
        host_id = identifier(host_id)
        proposed = offer(value.get("offer"))
        reports = value.get("reports", {})
        if not isinstance(reports, dict) or len(reports) > 10000:
            raise Error("Invalid machine inventory.", 400)
        with self.transaction() as db:
            previous = self._authenticate(db, host_id, credential)
            if json.loads(previous['offer'])['provider'] != proposed['provider']:
                raise Error('An enrolled runner cannot change provider; register a separate identity.',409)
            checks_requested = self._record_infrastructure(db, host_id, value)
            self._record_host_images(db,host_id,value.get('installedImages'))
            self._report_image_tasks(db,host_id,value.get('imageReports',{}))
            self._validate_catalogue_offer(db,host_id,proposed)
            self._register_templates(db, proposed)
            for machine_id, report in reports.items():
                machine_id = identifier(machine_id)
                if not isinstance(report, dict) or report.get("state") not in ("pending", "starting", "running", "stopping", "stopped", "error", "unknown"):
                    raise Error("Invalid observed state.", 400)
                detail = report.get("detail", "")
                if not isinstance(detail, str) or len(detail) > 2000:
                    raise Error("Invalid status detail.", 400)
                assigned = db.execute("SELECT host FROM machines WHERE id=?", (machine_id,)).fetchone()
                if not assigned or assigned[0] != host_id:
                    raise Error("Cannot report a machine assigned to another host.", 403)
                if self._deleted(db,machine_id):continue # Late reports cannot resurrect a reclaimed assignment.
                if self._report_lease_cleanup(db,machine_id,report) is False:continue
                if self._deleted(db,machine_id):continue
                db.execute("UPDATE machines SET observed=?,detail=?,updated=? WHERE id=?", (report["state"], detail, self.clock(), machine_id))
                if 'accessReady' in report:
                    if type(report['accessReady']) is not bool:raise Error('Invalid guest connection readiness.',400)
                    db.execute('UPDATE machines SET access_ready=? WHERE id=?',(int(report['accessReady']),machine_id))
                elif report['state']!='running':
                    db.execute('UPDATE machines SET access_ready=CASE WHEN access_ready IS NULL THEN NULL ELSE 0 END WHERE id=?',(machine_id,))
                self._report_power_off(db,machine_id,report)
                self._report_deletion(db,machine_id,report)
                if report.get('leaseFenced') is True:
                    lease=db.execute('SELECT l.* FROM leases l JOIN lease_members m ON m.lease=l.id WHERE m.machine=?',(machine_id,)).fetchone()
                    if lease:self._end_lease(db,lease,'failed')
                preparation = report.get("preparation")
                if preparation is not None:
                    if not isinstance(preparation, dict) or preparation.get("state") not in ("pending", "ready", "failed"):
                        raise Error("Invalid preparation report.", 400)
                    token_hash = preparation.get("tokenHash", "")
                    if not isinstance(token_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", token_hash):
                        raise Error("Invalid preparation credential hash.", 400)
                    previous = db.execute("SELECT preparation_hash,prepared_at,preparation_state FROM machines WHERE id=?", (machine_id,)).fetchone()
                    if previous[0] and previous[0] != token_hash:
                        raise Error("Preparation credential changed; inspect the host identity/state.")
                    # A successful receipt is durable; a subsequent stale pending report cannot undo it.
                    state = "ready" if previous[1] or preparation["state"] == "ready" else "failed" if previous[2] == "failed" else preparation["state"]
                    prepared_at = previous[1] or (self.clock() if state == "ready" else 0)
                    db.execute("UPDATE machines SET preparation_hash=?,preparation_state=?,prepared_at=? WHERE id=?", (token_hash, state, prepared_at, machine_id))
            self._report_jobs(db, host_id, value.get("inferenceReports", {}))
            self._report_device_operations(db, host_id, value.get("deviceReports", {}))
            db.execute("UPDATE hosts SET offer=?,seen=? WHERE id=?", (json.dumps(proposed), self.clock(), host_id))
            self._refresh_leases(db)
            self._refresh_access_sessions(db)
            self._close_consumer_operations(db)
            return {"checksRequestedAt": checks_requested, "machines": [self._lease_cleanup_assignment(db,self._deletion_assignment(db,self._power_assignment(db,self._leased_assignment(db,self._machine(row, True))))) for row in db.execute("SELECT * FROM machines WHERE host=?", (host_id,)) if not self._deleted(db,row['id'])],
                    "inferenceJobs": self._assigned_jobs(db, host_id),
                    "deviceOperations": self._assigned_device_operations(db, host_id),
                    'accessSessions':self._assigned_access_sessions(db,host_id),
                    'imageTasks':self._assigned_image_tasks(db,host_id),
                    'imageAcknowledged':self._acknowledged_images(db,host_id)}

    def hosts(self):
        with self.transaction() as db:
            result = []
            for row in db.execute("SELECT * FROM hosts WHERE id NOT IN (SELECT id FROM retired_runners) ORDER BY id"):
                item = json.loads(row["offer"])
                item.update(id=row["id"], online=self.clock() - row["seen"] < self.lease_seconds,
                            enabled=bool(row["enabled"]), lastSeen=row["seen"], reserved=self._used(db, row["id"]))
                item['kind'] = 'orchestrator' if item['provider']=='kubevirt' else 'host'
                health = db.execute('SELECT * FROM host_health WHERE host=?',(row['id'],)).fetchone()
                item['health'] = {**json.loads(health['report']), 'receivedAt':health['received'], 'fresh':self.clock()-health['received']<120} if health and health['report'] else None
                system=(item['health'] or {}).get('environment',{}).get('system')
                item['platform']={'Darwin':'macos','Linux':'linux','Windows':'windows'}.get(system,item['provider'] if item['provider'] in ('macos','linux','windows') else {'apple':'macos','ios':'macos','hyperv':'windows','libvirt':'linux'}.get(item['provider']))
                item['runtimes']=item.get('runtimes',[item['provider']] if item['provider']!='kubevirt' else [])
                item['placementReady'] = item['online'] and item['enabled'] and self._health_ready(db,row['id'])
                sample = db.execute('SELECT * FROM resource_samples WHERE host=? ORDER BY captured DESC LIMIT 1',(row['id'],)).fetchone()
                item['usage'] = {**json.loads(sample['report']), 'receivedAt':sample['captured'], 'fresh':item['online'] and self.clock()-sample['captured']<30} if sample else None
                item['available'] = self._remaining_capacity(db,row['id'])
                item['limits'] = self._host_limits(db,row['id'])
                item['overcommitted'] = any(item['reserved'][key]>min(item['capacity'][key],item['limits'][key]) for key in item['capacity'])
                result.append(item)
            return result

    def enable(self, host_id, enabled):
        with self.transaction() as db:
            if db.execute("UPDATE hosts SET enabled=? WHERE id=?", (int(enabled), identifier(host_id))).rowcount != 1:
                raise Error("Unknown host.", 404)
        return {"id": host_id, "enabled": enabled}

    def _machine(self, row, online):
        result = json.loads(row["request"])
        result.update(ownerId=row["owner"], hostId=row["host"], template=json.loads(row["template"]), desired=row["desired"],
                      observed=row["observed"] if online else "unknown", detail=row["detail"], updatedAt=row["updated"])
        required = result["template"].get("preparationDriver", "none") != "none"
        result["preparation"] = {"state": row["preparation_state"] if required else "notRequired", "completedAt": row["prepared_at"] or None}
        result["ready"] = result["observed"] == "running" and (not required or bool(row["prepared_at"]))
        if result['template'].get('guestAccess'):result['ready']=result['ready'] and bool(row['access_ready'])
        result['guestConnectionReady']=None if row['access_ready'] is None else bool(row['access_ready'])
        mobile = result["template"]["os"] in ("android", "ios")
        guest = result["template"].get("guestAccess", False)
        graphical=(mobile or bool(guest)) and result['template']['mode']!='headless'
        result["capabilities"] = {"desktopStream": graphical, "screenshot": graphical,
                                  "files": mobile or bool(guest), "shell": result["template"]["os"] == "android" or bool(guest),
                                  "accessibility": graphical}
        return result

    def prepared(self, machine_id, credential):
        with self.transaction() as db:
            row = db.execute("SELECT preparation_hash,prepared_at FROM machines WHERE id=?", (identifier(machine_id),)).fetchone()
            if not row or not row[0] or not secrets.compare_digest(row[0], digest(credential)):
                raise Error("Preparation credential rejected.", 401)
            db.execute("UPDATE machines SET preparation_state='ready',prepared_at=? WHERE id=?", (row[1] or self.clock(), identifier(machine_id)))
        return {"prepared": True}

    def templates(self):
        result = []
        for host in self.hosts():
            for image in host["templates"]:
                result.append({**image, "hostId": host["id"], "online": host["online"], "accepting": host["placementReady"]})
        return result

    def machines(self):
        with self.transaction() as db:
            return [self._deletion_assignment(db,self._power_assignment(db,self._machine(row, self.clock() - row["seen"] < self.lease_seconds))) for row in
                    db.execute("SELECT m.*,h.seen FROM machines m JOIN hosts h ON m.host=h.id ORDER BY m.id") if not self._deleted(db,row['id']) and self._human_visible(row)]

    def _human_visible(self, row):
        from .authorization import current
        policy=current.get()
        return policy is None or policy.principal['kind']=='operator' or policy.principal['user']['role']=='admin' or row['owner']==policy.principal['user']['id']

    def _used(self, db, host_id, exclude=None):
        used = self._inference_used(db, host_id)
        used['diskGiB']+=self._image_used(db,host_id)
        for row in db.execute("SELECT * FROM machines WHERE host=?", (host_id,)):
            if row["id"] == exclude or self._deleted(db,row['id']):
                continue
            size = json.loads(row["request"])["resources"]
            # Disks remain reserved even after shutdown. Unknown effects never release capacity.
            used["diskGiB"] += size["diskGiB"]
            if self._compute_reserved(db,row):
                for key in ("cpu", "memoryMiB"):
                    used[key] += size[key]
        return used

    def create(self, value):
        from .accounts import fields
        fields(value,('id','name','templateId','resources','templateRevision','hostId','arch'))
        request = machine_request(value)
        with self.transaction() as db:
            return self._create_machine(db,request)

    def _create_machine(self,db,request,leased=False):
        old = db.execute("SELECT * FROM machines WHERE id=?", (request["id"],)).fetchone()
        if old:
            if json.loads(old["intent"]) != request:
                raise Error("Request identity is already used for another specification.")
            seen = db.execute("SELECT seen FROM hosts WHERE id=?", (old["host"],)).fetchone()[0]
            return self._deletion_assignment(db,self._machine(old, self.clock() - seen < self.lease_seconds))
        candidates = []
        for host in db.execute("SELECT * FROM hosts WHERE enabled=1 ORDER BY id"):
            if not self._health_ready(db,host['id']) or self.clock() - host["seen"] >= self.lease_seconds or request.get("hostId", host["id"]) != host["id"]:
                continue
            advertised = json.loads(host["offer"])
            used = self._used(db, host["id"])
            remaining = self._remaining_capacity(db,host['id'])
            for image in advertised["templates"]:
                if leased and not lease_eligible(advertised,image):continue
                if image["id"] != request["templateId"] or request.get("arch", image["arch"]) != image["arch"]:
                    continue
                if request.get("templateRevision", image["revision"]) != image["revision"]:
                    continue
                size = {**image.get("defaults", image["minimum"]), **request["resources"]}
                if size["memoryMiB"] % image.get("memoryStepMiB", 1) == 0 and all(image["minimum"][key] <= size[key] <= remaining[key] for key in used):
                    score = used["memoryMiB"] / advertised["capacity"]["memoryMiB"]
                    candidates.append((score, host["id"], image, size))
        if not candidates:
            raise Error("No online accepting host offers this template and enough unreserved capacity.")
        if "templateRevision" not in request and len({item[2]["revision"] for item in candidates}) > 1:
            raise Error("Multiple template revisions are available; choose templateRevision explicitly.")
        _, host_id, image, size = min(candidates, key=lambda item: (item[0], item[1]))
        effective = {**request, "resources": size}
        from .authorization import current
        policy=current.get()
        owner=policy.principal['user']['id'] if not leased and policy is not None and policy.principal['kind']!='operator' else None
        db.execute("INSERT INTO machines (id,request,host,template,desired,observed,detail,updated,intent,owner) VALUES (?,?,?,?,?,?,?,?,?,?)", (request["id"], json.dumps(effective), host_id, json.dumps(image), "running", "pending", "", self.clock(), json.dumps(request), owner))
        row = db.execute("SELECT * FROM machines WHERE id=?", (request["id"],)).fetchone()
        return self._machine(row, True)

    def desired(self, machine_id, state):
        machine_id = identifier(machine_id)
        if state not in ("running", "stopped"):
            raise Error("Desired state must be running or stopped.", 400)
        with self.transaction() as db:
            row = db.execute("SELECT * FROM machines WHERE id=?", (identifier(machine_id),)).fetchone()
            if not row:
                raise Error("Unknown machine.", 404)
            if self._deletion(db,machine_id):raise Error('A machine with a deletion intent cannot change desired state.',409)
            if db.execute('SELECT 1 FROM lease_members WHERE machine=?',(machine_id,)).fetchone():
                raise Error('Lease-owned machines use lease lifecycle actions.',409)
            if state == "running" and row["desired"] != "running":
                if db.execute("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'",(machine_id,)).fetchone():raise Error('Resolve the pending power-off intent before restarting.',409)
                if db.execute("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')",(machine_id,)).fetchone():
                    raise Error('Resolve the pending image capture before restarting this machine.',409)
                host = db.execute("SELECT * FROM hosts WHERE id=?", (row["host"],)).fetchone()
                if not host["enabled"] or not self._health_ready(db,host['id']) or self.clock() - host["seen"] >= self.lease_seconds:
                    raise Error("Assigned host is offline or draining.")
                remaining = self._remaining_capacity(db,host['id'],exclude=machine_id)
                size = json.loads(row["request"])["resources"]
                if not all(size[key] <= remaining[key] for key in size):
                    raise Error("Assigned host has insufficient unreserved capacity to restart.")
            db.execute("UPDATE machines SET desired=? WHERE id=?", (state, machine_id))
            return self._machine(db.execute("SELECT * FROM machines WHERE id=?", (machine_id,)).fetchone(), True)
