import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Environment } from "../src/host-runtimes/core.ts";
import { matchesManagedFile, nativeRecord } from "../src/host-runtimes/native.ts";

test("managed containerd files require the expected digest, permissions and path ownership", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "containerd-receipt-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid!();
  const inspect = ((path: string) => path.startsWith(root) ? lstatSync(path) : {
    isDirectory: () => true, uid, mode: 0o755,
  }) as typeof lstatSync;
  const bytes = Buffer.alloc(130_000, 1);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = join(root, "binary");
  const matches = (candidate = path) => matchesManagedFile(candidate, digest, 0o755, uid, inspect);
  writeFileSync(path, bytes);
  chmodSync(path, 0o755);
  assert.equal(await matches(), true);
  writeFileSync(path, Buffer.alloc(bytes.length, 2));
  assert.equal(await matches(), false);
  writeFileSync(path, bytes);
  chmodSync(path, 0o777);
  assert.equal(await matches(), false);
  chmodSync(path, 0o755);
  chmodSync(root, 0o777);
  assert.equal(await matches(), false);
  chmodSync(root, 0o700);
  const symlink = join(root, "symlink");
  symlinkSync(path, symlink);
  assert.equal(await matches(symlink), false);
  linkSync(path, join(root, "hardlink"));
  assert.equal(await matches(), false);
  assert.equal(await matches(join(root, "missing")), false);
});

test("a containerd receipt cannot select arbitrary files or omit managed files", async () => {
  const sha256 = "1".repeat(64);
  const receipt = {
    type: "canaveral-host-installer-receipt", version: 1, component: "containerd", installedAt: 1,
    assets: ["containerd", "runc"].map(name => ({ name, version: "1.2.3", sha256 })),
    unit: "/etc/systemd/system/canaveral-containerd.service", socket: "/run/canaveral-containerd/containerd.sock",
  };
  const env: Environment = {
    platform: "linux", arch: "x64",
    receipt: () => ({ ...receipt, files: [{ path: "/etc/passwd", sha256 }] }),
    lstat: () => { throw Object.assign(new Error("Missing fixture path"), { code: "ENOENT" }); },
    run: async () => assert.fail("containerd file verification must not invoke a command"),
  };
  const result = await nativeRecord("containerd", {}, env);
  assert.equal(result.state, "unknown");
  assert.equal(result.blocker?.code, "containerd_receipt_invalid");
});
