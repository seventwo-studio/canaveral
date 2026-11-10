import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AndroidProvider } from "../../src/providers/android.ts";
import type { MobileTransport, RecordValue } from "../../src/providers/mobile.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mobile-accessibility-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image: RecordValue = { id: "android", revision: "1", os: "android", mode: "device", arch: "arm64", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } }, machine: RecordValue = { id: randomUUID(), template: image, desired: "running", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } };
  let elapsed = 100, ancestor = "original", allowed = true, revokeLookup = false; const calls: string[][] = [];
  const transport: MobileTransport = { elapsed: () => elapsed, run: async argv => {
    calls.push([...argv]); let stdout: Buffer | string = "";
    if (argv.at(-1) === "sys.boot_completed") { stdout = "1"; if (revokeLookup) allowed = false; }
    else if (argv.includes("cat")) stdout = `<hierarchy><node class="View" text="${ancestor}" bounds="[0,0][100,100]"><node class="Button" text="secret" password="true" enabled="true" clickable="true" bounds="[10,20][30,40]"/></node></hierarchy>`;
    else if (argv.includes("screencap")) stdout = Buffer.from("89504e470d0a1a0a0000000d494844520000006400000064", "hex");
    return { stdout, exitCode: 0 };
  } };
  const provider = new AndroidProvider({ storage: path.join(root, "storage"), androidSDK: "/fixture/sdk", transport }, root);
  provider.endpoint = async () => "fixture"; provider.owned = async () => {};
  const request = (action: string, args: RecordValue = {}) => ({ id: randomUUID(), action, arguments: args, expiresAt: Date.now() / 1000 + 120 });
  return { root, image, machine, provider, calls, request, check: () => allowed, expire: () => { elapsed += 16; }, changeAncestor: () => { ancestor = "changed"; }, revokeDuringLookup: () => { revokeLookup = true; } };
}

test("mobile accessibility captures native frame, redacts passwords and clicks only revalidated targets", async t => {
  const f = fixture(t), report = await f.provider.operate(f.machine, f.image, f.root, f.request("accessibility"), f.check);
  assert.equal(report.state, "succeeded"); const nodes = report.result.nodes as RecordValue[]; assert.equal(nodes[1]!.name, ""); assert.equal((nodes[1]!.properties as RecordValue).text, "[redacted]"); assert.ok(report.result.frame);
  const result = await f.provider.operate(f.machine, f.image, f.root, f.request("accessibility-action", { snapshotId: report.result.snapshotId, nodeId: nodes[1]!.id, nativeAction: "click" }), f.check);
  assert.equal(result.state, "succeeded"); assert.ok(f.calls.some(c => c.at(-1) === "'input' 'tap' '20' '30'"));
});

test("mobile accessibility rejects changed lineage, stale snapshots and unsupported native actions", async t => {
  for (const mode of ["lineage", "stale", "unsupported"]) {
    const f = fixture(t), snapshot = await f.provider.operate(f.machine, f.image, f.root, f.request("accessibility"), f.check);
    if (mode === "lineage") f.changeAncestor(); if (mode === "stale") f.expire();
    const result = await f.provider.operate(f.machine, f.image, f.root, f.request("accessibility-action", { snapshotId: snapshot.result.snapshotId, nodeId: "ax-2", nativeAction: mode === "unsupported" ? "type" : "click" }), f.check);
    assert.equal(result.state, "failed"); assert.equal(result.result.code, "input_rejected"); assert.ok(!f.calls.some(c => c.at(-1)?.includes("'tap'")));
  }
});

test("authorization lost during readiness lookup prevents the later native mutation", async t => {
  const f = fixture(t); f.revokeDuringLookup(); const result = await f.provider.operate(f.machine, f.image, f.root, f.request("tap", { x: 10, y: 20 }), f.check);
  assert.equal(result.state, "unknown"); assert.ok(!f.calls.some(c => c.at(-1)?.includes("'tap'")));
});
