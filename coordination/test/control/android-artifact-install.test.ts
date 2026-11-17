import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AndroidProvider } from "../../src/providers/android.ts";
import type { Download, MobileTransport, NativePipe, RecordValue } from "../../src/providers/mobile.ts";

function fixture(t: { after(fn: () => void): void }, mode = "normal") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-install-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image: RecordValue = { id: "android", revision: "1", os: "android", arch: "arm64", mode: "device", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } };
  const machine: RecordValue = { id: randomUUID(), template: image, desired: "running", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } };
  const payload = Buffer.alloc(150001, 173), sha256 = createHash("sha256").update(payload).digest("hex"), calls: string[][] = [];
  let allowed = mode !== "revoked", sourceClosed = false, pipeClosed = false, offset = 0, consumed = false, verification = 0, written = Buffer.alloc(0), requested = 0;
  const source: Download = {
    size: payload.length,
    read: async count => { requested = Math.max(requested, count); const bytes = mode === "short-source" ? Buffer.alloc(0) : payload.subarray(offset, offset + count); offset += bytes.length; return bytes; },
    verify: async () => { verification++; return mode !== "bad-source" && !(mode === "changed-source" && verification > 1); },
    close: async () => { sourceClosed = true; },
  };
  let finish!: () => void;
  const ended = new Promise<void>(resolve => { finish = resolve; });
  const transport: MobileTransport = {
    run: async argv => {
      calls.push([...argv]);
      let stdout = "";
      if (argv.at(-1) === "sys.boot_completed") stdout = mode === "not-booted" ? "0" : "1";
      else if (argv.includes("install-create")) stdout = mode === "bad-create" ? "Success: created install session [foreign]" : "Success: created install session [42]";
      else if (argv.includes("install-commit")) { if (mode === "lost-commit") throw new Error("commit response lost"); stdout = mode === "failed-commit" ? "Failure [INVALID_APK]" : "Success"; }
      else if (argv.includes("install-abandon")) stdout = "Success";
      return { stdout, exitCode: 0 };
    },
    pipe: async argv => {
      calls.push([...argv]);
      const pipe: NativePipe = {
        read: async () => { await ended; if (consumed || pipeClosed) return Buffer.alloc(0); consumed = true; return Buffer.from(mode === "bad-stage" ? "Success: streamed 1 bytes" : `Success: streamed ${payload.length} bytes\n`); },
        write: async bytes => { if (mode === "write-error") throw new Error("write failed"); const count = Math.min(bytes.length, 17001); written = Buffer.concat([written, bytes.subarray(0, count)]); return count; },
        end: async () => { if (mode === "revoke-before-commit") allowed = false; finish(); },
        wait: async () => mode === "failed-stage" ? 1 : 0,
        close: async () => { pipeClosed = true; finish(); },
      };
      return pipe;
    },
  };
  const provider = new AndroidProvider({ storage: path.join(root, "storage"), androidSDK: "/fixture/sdk", transport }, root);
  provider.endpoint = async () => mode === "missing-device" ? undefined : "emulator-5554";
  provider.owned = async () => { if (mode === "foreign-device") throw new Error("foreign device"); };
  return { machine, image, provider, source, sha256, calls, payload, get written() { return written; }, get sourceClosed() { return sourceClosed; }, get pipeClosed() { return pipeClosed; }, get requested() { return requested; },
    install: (digest = sha256) => provider.installArtifact(machine, image, root, source, digest, () => allowed) };
}

test("Android uploaded APK installation streams bounded bytes and commits its exact owned session", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.install(), { installed: true, sha256: f.sha256, bytes: f.payload.length, artifactCleaned: true });
  assert.deepEqual(f.written, f.payload); assert.ok(f.sourceClosed && f.pipeClosed); assert.equal(f.requested, 65536);
  assert.deepEqual(f.calls.filter(call => call.includes("install-create") || call.includes("install-commit")).map(call => call.slice(3)), [
    ["shell", "pm", "install-create", "-r", "-S", String(f.payload.length)], ["shell", "pm", "install-commit", "42"],
  ]);
  assert.ok(f.calls.some(call => call.slice(-7).join(" ") === `pm install-write -S ${f.payload.length} 42 base.apk -`));
  assert.ok(!f.calls.some(call => call.includes("install-abandon") || call.includes("install")));
});

test("Android refuses changed sources, wrong digests and incomplete staging before commit", async t => {
  for (const mode of ["changed-source", "short-source", "bad-stage", "failed-stage", "write-error", "wrong-digest"]) {
    const f = fixture(t, mode); await assert.rejects(f.install(mode === "wrong-digest" ? "0".repeat(64) : f.sha256));
    assert.ok(f.sourceClosed && f.pipeClosed, mode);
    assert.ok(!f.calls.some(call => call.includes("install-commit")), mode);
    assert.ok(f.calls.some(call => call.includes("install-abandon") && call.at(-1) === "42"), mode);
  }
});

test("Android preflight failures close their source without creating package sessions", async t => {
  for (const mode of ["revoked", "bad-source", "not-booted", "missing-device", "foreign-device"]) {
    const f = fixture(t, mode); await assert.rejects(f.install());
    assert.ok(f.sourceClosed, mode); assert.ok(!f.calls.some(call => call.includes("install-create")), mode);
  }
  for (const sha256 of ["bad", "A".repeat(64)]) { const f = fixture(t); await assert.rejects(f.install(sha256)); assert.ok(f.sourceClosed); assert.deepEqual(f.calls, []); }
  const leased = fixture(t); leased.machine.lease = { id: randomUUID() }; await assert.rejects(leased.install(), { code: "capability_unsupported" }); assert.ok(leased.sourceClosed); assert.deepEqual(leased.calls, []);
});

test("Android unknown create/commit and revoked installation never abandon or replay sessions", async t => {
  for (const mode of ["bad-create", "lost-commit", "failed-commit", "revoke-before-commit"]) {
    const f = fixture(t, mode); await assert.rejects(f.install());
    assert.ok(f.sourceClosed, mode); assert.ok(!f.calls.some(call => call.includes("install-abandon")), mode);
    assert.equal(f.calls.filter(call => call.includes("install-create")).length, 1);
    assert.equal(f.calls.filter(call => call.includes("install-commit")).length, ["lost-commit", "failed-commit"].includes(mode) ? 1 : 0);
  }
});
