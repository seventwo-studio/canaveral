import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { createModule, saveBlueprint } from "../../src/control/blueprints.ts";
import { createModule as imagesModule, ImagesController, reportImageTasks } from "../../src/control/images.ts";
import { ServiceError } from "../../src/errors.ts";
import { createModule as inferenceModule } from "../../src/control/inference.ts";
import { LegacyLeases } from "../../src/control/leases.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";

const token = () => randomBytes(32).toString("base64url");
const admin: Principal = { kind: "operator", user: null, scopes: ["admin"] };
const user: Principal = { kind: "token", user: { id: randomUUID(), username: "alice", role: "user", status: "active" }, scopes: ["machines:read", "machines:write"] };
const req = (path = "/v1/blueprints", method = "GET", body = {}, principal = admin): ControlRequest => ({ path, method, body, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), token: token(), principal: () => principal });
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "blueprints-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(join(root, "db"), () => 1000);
  const options = { adminToken: token(), enrollmentToken: token(), controllerId: randomUUID() };
  const machines = new MachineStore(store, options), host = randomUUID(), credential = token();
  inferenceModule(store, options);
  new LegacyLeases(store, options);
  const minimum = { cpu: 1, memoryMiB: 512, diskGiB: 4 };
  const original = { id: "ubuntu", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum, mediaType: "disk", imageKind: "base", source: { path: "/operator/original.raw", sha256: "a".repeat(64), format: "raw" } };
  const prepared = { ...original, id: "development", imageKind: "derived", source: { ...original.source, path: "/operator/prepared.raw", sha256: "b".repeat(64) } };
  const offer = { name: "Fixture host", provider: "libvirt", capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 }, templates: [original, prepared] };
  machines.enroll({ id: host, credential, offer }, options.enrollmentToken);
  const spec = { id: randomUUID(), revision: "1", name: "Development", source: { id: "development", revision: "1", arch: "amd64" }, defaults: { cpu: 2, memoryMiB: 2048, diskGiB: 12 } };
  return { root, store, options, machines, host, credential, offer, original, spec };
}
const fails = (status: number) => (e: unknown) => e instanceof ServiceError && e.status === status;

test("blueprints persist immutable revisions and strip private source/recipe contents", t => {
  const f = fixture(t), routes = createModule(f.store);
  const saved = routes.handle(req("/v1/blueprints", "POST", f.spec)) as { body: Record<string, unknown> };
  assert.equal(saved.body.name, "Development");
  assert.doesNotMatch(JSON.stringify(saved), /operator\/|prepared.raw|source.*path/);
  assert.deepEqual(routes.handle(req("/v1/blueprints", "POST", f.spec)), saved);
  assert.throws(() => routes.handle(req("/v1/blueprints", "POST", { ...f.spec, defaults: { ...f.spec.defaults, cpu: 3 } })), fails(409));
  routes.handle(req("/v1/blueprints", "POST", { ...f.spec, revision: "2", defaults: { ...f.spec.defaults, cpu: 3 } }));
  const listed = routes.handle(req("/v1/blueprints", "GET", {}, user)) as { body: { blueprints: unknown[] } };
  assert.equal(listed.body.blueprints.length, 2);
  assert.throws(() => routes.handle(req("/v1/blueprints", "POST", f.spec, user)), fails(403));
  assert.throws(() => routes.handle(req("/v1/blueprints", "GET", {}, { ...user, scopes: [] })), fails(403));
  assert.throws(() => f.store.transaction(db => saveBlueprint(db, { ...f.spec, defaults: { cpu: 1, memoryMiB: 100, diskGiB: 4 } })), fails(400));
  assert.throws(() => f.store.transaction(db => saveBlueprint(db, { ...f.spec, image: { source: "/untrusted" } })), fails(400));
});

test("creation pins the prepared source and defaults; retries, ownership and constraints survive new revisions", t => {
  const f = fixture(t); f.store.transaction(db => saveBlueprint(db, f.spec));
  const intent = { id: randomUUID(), name: "Developer box", blueprintId: f.spec.id, blueprintRevision: "1" };
  const created = f.machines.create(intent, req("/v1/machines", "POST", intent, user));
  assert.equal(created.ownerId, user.user!.id); assert.equal(created.templateId, "development");
  assert.deepEqual(created.resources, f.spec.defaults);
  assert.equal(created.template.imageKind, "derived"); assert.equal(created.blueprintId, f.spec.id);
  f.store.transaction(db => saveBlueprint(db, { ...f.spec, revision: "2", defaults: { ...f.spec.defaults, cpu: 4 } }));
  f.machines.enable(f.host, false, req());
  assert.deepEqual(f.machines.create(intent, req("/v1/machines", "POST", intent, user)), created);
  assert.throws(() => f.machines.create({ ...intent, blueprintRevision: "2" }, req("/v1/machines", "POST", {}, user)), fails(409));
  assert.throws(() => f.machines.create(intent, req("/v1/machines", "POST", {}, { ...user, user: { ...user.user!, id: randomUUID() } })), fails(404));
  f.machines.enable(f.host, true, req());
  assert.throws(() => f.machines.create({ ...intent, id: randomUUID(), resources: { memoryMiB: 128 } }, req()), fails(409));
  assert.throws(() => f.machines.create({ ...intent, id: randomUUID(), resources: { cpu: 100 } }, req()), fails(409));
  assert.throws(() => f.machines.create({ ...intent, id: randomUUID(), blueprintRevision: "missing" }, req()), fails(404));
  assert.throws(() => f.machines.create({ ...intent, id: randomUUID(), templateId: "ubuntu" }, req()), fails(400));
  assert.throws(() => f.store.transaction(db => f.machines.createMachine(db, { ...intent, id: randomUUID() }, true)), fails(400));
  const override = f.machines.create({ ...intent, id: randomUUID(), resources: { cpu: 3 } }, req());
  assert.equal(override.resources.cpu, 3); assert.equal(override.resources.memoryMiB, 2048);
  const assignments = f.machines.heartbeat(f.host, f.credential, { offer: f.offer, reports: {} });
  assert.equal(assignments.machines.find((m: { id: string }) => m.id === created.id).templateId, "development");
  assert.equal(f.offer.templates[0], f.original);
});

test("image library returns downloaded bases and excludes prepared capture artifacts", t => {
  const f = fixture(t), imports = new ImagesController(f.store), imageRoutes = imagesModule(f.store, f.options);
  const metadata = { id: randomUUID(), name: "Ubuntu original", os: "linux", arch: "amd64", mode: "headless", mediaType: "disk", format: "raw", minimum: f.original.minimum };
  imports.reserveImageImport(f.host, metadata, 512);
  imports.finishImageImport(metadata.id, f.host, { ...metadata, sha256: "c".repeat(64), bytes: 512, kind: "base", revision: "1" });
  const machine = f.machines.create({ id: randomUUID(), name: "Prepared", templateId: "ubuntu" }, req());
  // Fixture supplies stopped runtime evidence; it does not run a native guest.
  f.store.transaction(db => db.prepare("UPDATE machines SET desired='stopped',observed='stopped' WHERE id=?").run(machine.id));
  const capture = { id: randomUUID(), machineId: machine.id, name: "Prepared snapshot" };
  imports.createCapture(capture);
  f.store.transaction(db => reportImageTasks(db, f.host, { [capture.id]: { state: "succeeded", result: { ...metadata, id: capture.id, name: capture.name, sha256: "d".repeat(64), bytes: 512, kind: "derived", revision: "1", sourceMachineId: machine.id } } }, 1000));
  const library = imageRoutes.handle(req("/v1/image-library", "GET", {}, user)) as { body: { images: { id: string }[] } };
  assert.deepEqual(library.body.images.map(i => i.id), [metadata.id]);
  const all = imageRoutes.handle(req("/v1/images")) as { body: { images: unknown[] } };
  assert.equal(all.body.images.length, 2);
  assert.throws(() => imageRoutes.handle(req("/v1/image-library", "GET", {}, { ...user, scopes: [] })), fails(403));
});
