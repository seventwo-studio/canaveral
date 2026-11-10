import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";
import { credential, createModule, notifyScript, preparationReadiness, powershellScript, recordPreparation, seedFiles, sshPreparation, unixScript, userData } from "../../src/control/preparation.ts";
import { legacyDigest, recipe } from "../../src/control/templates.ts";
import type { ControlRequest } from "../../src/control/contracts.ts";
const id = randomUUID(), host = randomUUID(), token = "a".repeat(43);
const options = { controllerId: randomUUID(), adminToken: "b".repeat(43) };
const image = { os: "linux", prepare: { driver: "cloud-init", commands: ["touch /ready"] } };
function directory(t: { after(fn: () => void): void }): string { const dir = mkdtempSync(join(tmpdir(), "canaveral-preparation-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test("guest script runs once, quotes literal content and does not replay interrupted commands", t => {
  const dir = directory(t), output = join(dir, "output"), path = join(dir, "file with space");
  const prepared = recipe({ driver: "cloud-init", files: [{ path, content: "literal $(do-not-run)\n" }], commands: [`printf step >> '${output}'`] }, "linux")!;
  const script = unixScript(prepared, { id }).replaceAll(`/var/lib/canaveral/${id}`, join(dir, "state"));
  for (let i = 0; i < 2; i++) assert.equal(spawnSync("sh", { input: script, encoding: "utf8" }).status, 0);
  assert.equal(readFileSync(output, "utf8"), "step"); assert.equal(readFileSync(path, "utf8"), "literal $(do-not-run)\n");
  prepared.commands = ["exit 7", `printf should-not-run >> '${output}'`];
  const failing = unixScript(prepared, { id }).replaceAll(`/var/lib/canaveral/${id}`, join(dir, "failed-state"));
  assert.equal(spawnSync("sh", { input: failing }).status, 7); assert.equal(spawnSync("sh", { input: failing }).status, 42);
  assert.equal(readFileSync(output, "utf8"), "step");
});
test("NoCloud and ConfigDrive recipes bind unique identity and bounded scoped receipts without Python", () => {
  const data = userData({ ...image, cloneIdentity: "linux-cloud-init" }, { id }, "https://controller.example", token)!;
  const config = JSON.parse(data.slice("#cloud-config\n".length));
  const script = Buffer.from(config.write_files[0].content, "base64").toString();
  assert.ok(script.includes(`/v1/machines/${id}/prepared`)); assert.ok(script.includes("--max-redirs 0")); assert.ok(script.includes('"$attempt" -lt 120'));
  assert.equal(script.includes("python"), false); assert.ok(config.bootcmd[0][3].includes(id.replaceAll("-", "")));
  assert.throws(() => userData(image, { id }, "http://remote.example", token));
  assert.doesNotThrow(() => userData(image, { id }, "http://remote.example", token, true));
  assert.throws(() => userData(image, { id }, "https://user:password@example.com", token));
  const windows = { os: "windows", prepare: { driver: "cloudbase-init", commands: ["exit 9"] } };
  const files = seedFiles(windows, { id }, "https://controller.example", token)!;
  assert.equal(JSON.parse(files["openstack/latest/meta_data.json"]!).uuid, id);
  assert.ok(files["openstack/latest/user_data"]!.startsWith("#ps1_sysnative"));
  assert.ok(files["openstack/latest/user_data"]!.includes("-MaximumRedirection 0"));
  const disabled = userData(windows, { id }, "https://controller.example", token, false, false)!;
  assert.equal(disabled.includes("Authorization"), false);
  assert.equal(userData({ os: "linux" }, { id }, "https://controller.example", token), null);
});
test("SSH preparation preserves strict known hosts, complete assignment UUID and failure propagation", () => {
  const sshImage = { os: "linux", prepare: { driver: "ssh", commands: ["test -d /workspace"] }, ssh: { host: "cvm-{id}.example", user: "operator", identityFile: "/private/key", knownHostsFile: "/private/known hosts" } };
  const plan = sshPreparation(sshImage, { id });
  assert.ok(plan.argv.includes("StrictHostKeyChecking=yes")); assert.ok(plan.argv.includes(`operator@cvm-${id}.example`));
  assert.equal(plan.timeoutSeconds, 1800); assert.ok(plan.input.includes("sh -eu -c"));
  assert.throws(() => sshPreparation({ ...sshImage, ssh: { ...sshImage.ssh, host: "-bad" } }, { id }));
  assert.throws(() => sshPreparation({ ...sshImage, ssh: { ...sshImage.ssh, port: true } }, { id }));
  const ps = powershellScript(recipe({ driver: "cloudbase-init", commands: ["Write-Output ok"] }, "windows")!, { id });
  assert.ok(ps.includes("$LASTEXITCODE -ne 0")); assert.ok(ps.includes("Interrupted preparation requires inspection"));
  assert.throws(() => notifyScript("https://example.com", "bad"));
});
test("preparation credential persists privately and rejects linked state", t => {
  const dir = directory(t), first = credential(dir); assert.equal(credential(dir), first);
  const linked = join(dir, "linked"); const target = join(dir, "target");
  writeFileSync(target, JSON.stringify({ token }));
  // A separate folder avoids replacing the previously persisted credential.
  credential(linked); rmSync(join(linked, "preparation.json")); symlinkSync(target, join(linked, "preparation.json"));
  assert.throws(() => credential(linked));
});
test("preparation success is durable across stale pending/failed reports and exact callback retries", t => {
  const dir = directory(t), store = new SqliteStore(join(dir, "db"), () => 1000);
  store.transaction(db => {
    db.exec("CREATE TABLE machines(id TEXT PRIMARY KEY,host TEXT,preparation_hash TEXT,prepared_at REAL,preparation_state TEXT)");
    db.prepare("INSERT INTO machines VALUES (?,?,NULL,0,'pending')").run(id, host);
    recordPreparation(db, id, host, { state: "pending", tokenHash: legacyDigest(token) }, 1000);
    assert.throws(() => recordPreparation(db, id, randomUUID(), { state: "ready", tokenHash: legacyDigest(token) }, 1000));
  });
  const module = createModule(store, options), req: ControlRequest = { method: "POST", path: `/v1/machines/${id}/prepared`, parts: ["v1", "machines", id, "prepared"], query: new URLSearchParams(), token, body: { state: "ready" }, principal() { throw new Error("Scoped callback must not use account authorization."); } };
  assert.deepEqual(module.handle(req), { body: { prepared: true } });
  store.transaction(db => { recordPreparation(db, id, host, { state: "failed", tokenHash: legacyDigest(token) }, 1001); recordPreparation(db, id, host, { state: "pending", tokenHash: legacyDigest(token) }, 1002); });
  assert.deepEqual(module.handle(req), { body: { prepared: true } });
  const row = store.transaction(db => db.prepare("SELECT * FROM machines WHERE id=?").get(id)!);
  assert.equal(row.prepared_at, 1000); assert.equal(row.preparation_state, "ready");
  assert.equal(preparationReadiness({ ...row, observed: "running" }, { preparationDriver: "cloud-init" }).ready, true);
  assert.throws(() => module.handle({ ...req, token: "z".repeat(43) }));
  store.transaction(db => assert.throws(() => recordPreparation(db, id, host, { state: "ready", tokenHash: "0".repeat(64) }, 1003)));
});
