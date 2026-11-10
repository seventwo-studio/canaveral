import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { ContainerDirectory, ContainerFiles, ShellAdapter, MobileTransport } from "../../src/providers/mobile.ts";
import { createLinuxServices, startLinuxGuest } from "../../src/guest/linux-services.ts";
import { ServiceError } from "../../src/errors.ts";
import { loadHelperArtifacts, desktopRecipe } from "../../src/guest/access.ts";

function fixture() {
  const files = new Map<string, Buffer>([["/home/fixture", Buffer.from("old")]]), owned = new Set<string>();
  let syncs = 0, shells = 0, closes = 0, writes = 0, now = 101, actionStatus = 0, actions = 0;
  function directory(path: string): ContainerDirectory {
    const absolute = (name: string) => `${path === "/" ? "" : path}/${name}`;
    return {
      directory: async name => directory(absolute(name)), exists: async name => files.has(absolute(name)),
      list: async () => [...files.keys()].filter(f => f.startsWith(path + "/")).map(f => ({ name: f.slice(path.length + 1), kind: "file" })),
      async createExclusive(name) {
        const key = absolute(name); assert.equal(files.has(key), false); files.set(key, Buffer.alloc(0)); owned.add(key);
        return { write: async bytes => { const part = bytes.subarray(0, 65536); files.set(key, Buffer.concat([files.get(key)!, part])); return part.length; }, sync: async () => { syncs++; }, close: async () => {} };
      },
      renameOwned: async (from, to) => { assert.ok(owned.has(absolute(from))); files.set(absolute(to), files.get(absolute(from))!); files.delete(absolute(from)); },
      publishOwned: async (from, to, replace) => { if (!replace && files.has(absolute(to))) return "exists"; assert.ok(owned.has(absolute(from))); files.set(absolute(to), files.get(absolute(from))!); files.delete(absolute(from)); return "published"; },
      removeOwned: async name => { const key = absolute(name); if (owned.has(key)) { files.delete(key); owned.delete(key); } },
      sync: async () => { syncs++; }, close: async () => {},
      async download(name) {
        const key = absolute(name), original = files.get(key); assert.ok(original); let offset = 0;
        return { size: original.length, read: async maximum => { const part = original.subarray(offset, offset + maximum); offset += part.length; return part; }, verify: async () => files.get(key) === original, close: async () => {} };
      },
    };
  }
  const nativeFiles: ContainerFiles = { openRoot: async path => { assert.equal(path, "/"); return directory(path); } };
  const nativeShells: ShellAdapter = { async open(argv) {
    assert.deepEqual(argv, ["/bin/bash", "-il"]); shells++; let data = Buffer.alloc(0), ended = false;
    return { write: async text => { writes++; data = Buffer.concat([data, Buffer.from(text)]); return { written: Buffer.byteLength(text) }; }, resize: async (rows, cols) => ({ rows, cols }), read: async offset => ({ data: data.subarray(offset).toString("base64"), offset: data.length, truncated: false, exited: ended, exitCode: null }), close: async () => { closes++; ended = true; } };
  } };
  const nodes = [{ id: "root", parentId: null, depth: 0, path: [], role: "desktop", name: "Desktop", identifier: "", states: [], actions: [], bounds: null, properties: {} }, { id: "button", parentId: "root", depth: 1, path: [0], role: "button", name: "Save", identifier: "save", states: ["enabled"], actions: ["click"], bounds: { x: 10, y: 10, width: 50, height: 30 }, properties: {} }];
  const transport: Pick<MobileTransport, "run"> = { async run(argv, options) {
    if (argv.includes("--atspi-inspect")) return { exitCode: 0, stdout: JSON.stringify({ nodes, truncated: false, unavailableNodes: 0, startedAt: 100, expiresAt: 115 }) };
    if (argv.includes("--atspi-action")) { actions++; const body = JSON.parse(Buffer.from(options.input!).toString()); assert.deepEqual(body.chain, nodes); assert.equal(body.startedAt, 100); assert.equal(body.expiresAt, 115); return { exitCode: actionStatus, stdout: "" }; }
    assert.fail("native effects must not run in portable fixtures");
  } };
  const stat = async (path: string) => ({ dev: 1n, ino: 2n, size: BigInt(files.get(path)!.length), mtimeNs: 3n, ctimeNs: 4n, isFile: () => true }) as BigIntStats;
  return { nativeFiles, nativeShells, transport, stat, files, syncs: () => syncs, shells: () => shells, closes: () => closes, writes: () => writes, actions: () => actions, clock: () => now, time: (n: number) => { now = n; }, status: (n: number) => { actionStatus = n; } };
}
test("production Linux composition uses retained file handles and durable publication for inline and streamed files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guest-services-")), f = fixture();
  const services = createLinuxServices({ stateDirectory: dir, files: f.nativeFiles, shells: f.nativeShells, transport: f.transport, stat: f.stat, clock: f.clock, ready: () => true, mode: "headless" });
  try {
    const bytes = Buffer.alloc(524288, 0x81);
    assert.deepEqual(await services.control("push", { path: "/home/fixture", data: bytes.toString("base64") }), { written: bytes.length, durable: true });
    assert.deepEqual(f.files.get("/home/fixture"), bytes); assert.equal(f.syncs(), 2);
    const result = await services.control("pull", { path: "/home/fixture" }); assert.deepEqual(Buffer.from(result.data as string, "base64"), bytes);
    const source = await services.download("/home/fixture"); assert.equal(await source.verify(), true);
    f.files.set("/home/fixture", Buffer.from(bytes)); assert.equal(await source.verify(), false); await source.close();
    let live = true;
    await assert.rejects(services.upload("/home/fixture", { read: async () => { live = false; return Buffer.from("late"); } }, 4, () => live));
    assert.deepEqual(f.files.get("/home/fixture"), bytes);
    await assert.rejects(services.control("push", { path: "/home/../escape", data: "eA==" }));
    await assert.rejects(services.control("screenshot", {}), (e: unknown) => e instanceof ServiceError && e.code === "capability_unsupported");
  } finally { await services.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
test("Linux terminal service keeps nine independent UUIDs, durable restart refusal and UTF-8 byte acknowledgements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guest-terminals-")), f = fixture(), options = { stateDirectory: dir, files: f.nativeFiles, shells: f.nativeShells, transport: f.transport, stat: f.stat, clock: f.clock, mode: "headless" as const };
  const services = createLinuxServices(options), ids = Array.from({ length: 9 }, () => randomUUID());
  try {
    await Promise.all(ids.map(session => services.control("shell-open", { session })));
    assert.equal(f.shells(), 9); await services.control("shell-open", { session: ids[0] }); assert.equal(f.shells(), 9);
    assert.deepEqual(await services.control("shell-write", { session: ids[0], text: "🚀" }), { written: 4 });
    const read = await services.control("shell-read", { session: ids[0], offset: 0 }); assert.equal(Buffer.from(read.data as string, "base64").toString(), "🚀"); assert.equal(read.offset, 4);
    assert.deepEqual(await services.control("shell-resize", { session: ids[0], rows: 40, cols: 90 }), { resized: true });
    await services.control("shell-close", { session: ids[0] }); assert.equal(f.closes(), 1);
    await assert.rejects(services.control("shell-open", { session: ids[0] }));
  } finally { await services.close?.(); }
  const recovered = createLinuxServices(options);
  try { await assert.rejects(recovered.control("shell-open", { session: ids[1] })); assert.equal(f.shells(), 9); assert.equal(f.closes(), 9); }
  finally { await recovered.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
test("Linux AT-SPI uses Rust lifetime/lineage context and consumes uncertain actions without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guest-atspi-")), f = fixture();
  const services = createLinuxServices({ stateDirectory: dir, files: f.nativeFiles, shells: f.nativeShells, transport: f.transport, stat: f.stat, clock: f.clock, mode: "desktop" });
  try {
    const snapshot = await services.control("accessibility", { includeFrame: false }); assert.equal(snapshot.source, "linux-atspi");
    f.time(116); await assert.rejects(services.control("accessibility-action", { snapshotId: snapshot.snapshotId, nodeId: "button", nativeAction: "click" }), (e: unknown) => e instanceof ServiceError && e.code === "input_rejected"); assert.equal(f.actions(), 0);
    f.time(101); const fresh = await services.control("accessibility", { includeFrame: false }); f.status(43);
    const args = { snapshotId: fresh.snapshotId, nodeId: "button", nativeAction: "click" };
    await assert.rejects(services.control("accessibility-action", args), (e: unknown) => e instanceof ServiceError && e.outcome === "unknown");
    await assert.rejects(services.control("accessibility-action", args)); assert.equal(f.actions(), 1);
  } finally { await services.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
test("Linux shutdown waits for an in-flight PTY open and closes it without admitting late input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guest-closing-")), f = fixture();
  let release!: () => void, resized = 0, stopped = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const services = createLinuxServices({ stateDirectory: dir, files: f.nativeFiles, transport: f.transport, stat: f.stat, clock: f.clock, mode: "headless", shells: { async open() {
    await pending;
    return { read: async () => ({}), write: async () => { assert.fail("late input"); }, resize: async () => { resized++; return {}; }, close: async () => { stopped++; } };
  } } });
  try {
    const opening = services.control("shell-open", { session: randomUUID() }); void opening.catch(() => {});
    const stopping = services.close!(); release(); await assert.rejects(opening); await stopping;
    assert.equal(stopped, 1); assert.equal(resized, 0);
    await assert.rejects(services.control("shell-open", { session: randomUUID() }));
  } finally { await services.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
test("deterministic guest bundle contains runnable composition and checksum-pinned architecture-specific native payloads", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "guest-bundle-")));
  try {
    const helper = join(dir, "linux-elf"), elf = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(elf); elf.writeUInt16LE(3, 16); elf.writeUInt16LE(183, 18); writeFileSync(helper, elf);
    const builder = await import(new URL("../../../../script/build_guest_bundle.mjs", import.meta.url).href) as { buildGuestBundle(options: { nativeHelper: string; atspiHelper: string; arch: string }): { sha256: string; artifacts: { path: string; content: string; mode: string }[] } };
    const options = { nativeHelper: helper, atspiHelper: helper, arch: "arm64" };
    const first = builder.buildGuestBundle(options), second = builder.buildGuestBundle(options); assert.equal(first.sha256, second.sha256); assert.deepEqual(first.artifacts, second.artifacts);
    assert.ok(first.artifacts.find(a => a.path === "/opt/canaveral/server.mjs")!.content.includes("startLinuxGuest"));
    assert.ok(first.artifacts.find(a => a.path === "/opt/canaveral/modules/guest/linux-services.mjs")!.content.includes("nativeContainerFiles"));
    assert.ok(first.artifacts.find(a => a.path === "/opt/canaveral/install.mjs")!.content.includes("sha256"));
    assert.equal(first.artifacts.some(a => a.path.endsWith(".py")), false);
    const manifest = join(dir, "manifest.json"); writeFileSync(manifest, JSON.stringify(first.artifacts)); assert.deepEqual(loadHelperArtifacts(manifest), first.artifacts);
    for (const artifact of first.artifacts.filter(a => a.path.startsWith("/opt/canaveral/modules/"))) {
      const output = join(dir, artifact.path.slice("/opt/canaveral/".length)); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, artifact.content);
    }
    const emitted = await import(pathToFileURL(join(dir, "modules/guest/linux-services.mjs")).href) as { createLinuxServices?: unknown };
    assert.equal(typeof emitted.createLinuxServices, "function");
    const recipe = desktopRecipe("ssh-ed25519 Zml4dHVyZQ==", first.artifacts); assert.ok(recipe.commands.includes("/usr/local/bin/node /opt/canaveral/install.mjs"));
    assert.throws(() => builder.buildGuestBundle({ ...options, arch: "amd64" }), /architecture/);
    await assert.rejects(startLinuxGuest([]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
