import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Accounts } from "../src/accounts.ts";
import { ConsumerIdentities, applicationSpec } from "../src/consumers.ts";
import { SqliteStore } from "../src/sqlite.ts";

const reference = fileURLToPath(new URL("../../../fixtures/migration/coordination_reference.py", import.meta.url));
const password = "synthetic-migration-password-😀";
function fixture(t: { after: (callback: () => void) => void }) {
  const folder = mkdtempSync(join(tmpdir(), "canaveral-migration-parity-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "controller.sqlite");
  return { path, store: new SqliteStore(path, () => 80_000) };
}
function python(action: string, path: string, value: unknown): Record<string, unknown> {
  const result = spawnSync(process.env.CANAVERAL_REFERENCE_PYTHON ?? "python3", [reference, action, path], {
    input: JSON.stringify(value), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("Python user accounts retain login and revocation while refusing legacy TypeScript authority", t => {
  const { path, store } = fixture(t);
  const created = python("setup", path, { username: "ADMIN", password });
  assert.throws(() => new Accounts(store), /Use the Python controller/);
  const login = python("login", path, { username: "ADMIN", password });
  assert.deepEqual(python("session", path, { token: login.token }), { user: login.user, expiresAt: login.expiresAt });
  python("logout", path, { token: login.token });
  assert.equal(python("authorized", path, { token: login.token }).authorized, false);
  python("logout", path, { token: created.token });
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM user_sessions").get()!.n), 0);
});

test("legacy TypeScript account hashes and sessions migrate once into Python user identities", async t => {
  const { path, store } = fixture(t);
  const accounts = new Accounts(store);
  const created = await accounts.setup({ username: "admin", password });
  const migrated = python("session", path, { token: created.token });
  const user = migrated.user as { id: string; username: string; role: string };
  assert.equal(user.username, created.user.username);
  assert.equal(user.role, "admin");
  assert.match(user.id, /^[a-f0-9-]{36}$/);
  assert.equal(migrated.expiresAt, created.expiresAt);
  const login = python("login", path, { username: "ADMIN", password });
  assert.equal((login.user as { id: string }).id, user.id);
  assert.equal(accounts.authorized(created.token), false);
  assert.equal(accounts.authorized(login.token), false);
  await assert.rejects(accounts.login({ username: "admin", password }), /Username or password rejected/);
  assert.throws(() => new Accounts(store), /Use the Python controller/);
});

test("application policies, one-time credential hashes, rotations and revocation interoperate", t => {
  const { path, store } = fixture(t);
  const identities = new ConsumerIdentities(store);
  const spec = { id: "11111111-2222-4333-8444-555555555555", name: "Build agent", templates: [],
    limits: { resources: { cpu: 4, memoryMiB: 8192, diskGiB: 96 }, activeLeases: 2 } };
  const pythonCreated = python("create", path, spec);
  assert.equal(identities.authenticate(pythonCreated.credential).id, spec.id);
  const rotated = identities.rotate(spec.id);
  assert.equal(python("authenticate", path, { token: rotated.credential }).id, spec.id);
  python("revoke", path, { id: spec.id });
  assert.throws(() => identities.authenticate(rotated.credential));
  assert.throws(() => identities.rotate(spec.id));
  const nodeCreated = identities.create({ ...spec, id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  assert.equal(python("authenticate", path, { token: nodeCreated.credential }).id, nodeCreated.id);
  const pythonRotated = python("rotate", path, { id: nodeCreated.id });
  assert.equal(identities.authenticate(pythonRotated.credential).id, nodeCreated.id);
  identities.revoke(nodeCreated.id);
  assert.equal(identities.list().every(application => application.revoked), true);
});

test("Unicode policy ordering, resource limits and TTL defaults match the Python reference", t => {
  const { path } = fixture(t);
  const spec = { id: "11111111-2222-4333-8444-555555555555", name: "Build agent",
    templates: ["😀", "\uFFFF", "alpha"].map(id => ({ id, revision: "4", arch: "arm64" })),
    limits: { resources: { cpu: 4, memoryMiB: 8192, diskGiB: 96 }, activeLeases: 2 } };
  assert.deepEqual(applicationSpec(spec), python("spec", path, spec));
});
