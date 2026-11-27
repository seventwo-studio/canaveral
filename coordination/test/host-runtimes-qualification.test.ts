import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeInventory } from "../src/host-runtimes/index.ts";
import { modelIds, ProbeError, run } from "../src/host-runtimes/core.ts";
import type { Environment } from "../src/host-runtimes/core.ts";
import { containerdPromoted, promoted, promotionRules } from "../src/host-runtimes/qualification.ts";
import type { QualifiedPin } from "../src/host-runtimes/qualification.ts";
import { qualifiedPins } from "../src/host-runtimes/qualified-pins.ts";

const digest = "a".repeat(64);
const catalogPin = { version: "1.2.3", url: "https://example.invalid/llama.tgz", sha256: "b".repeat(64), treeSha256: "c".repeat(64), packageDigest: digest };
const llama = (overrides: Partial<QualifiedPin> = {}): QualifiedPin => ({
  backend: "llama.cpp", os: "linux", arch: "x86_64", acceleration: "cpu", executionMode: "cpu-generation",
  pinId: "1.2.3-000000000000000000000000", identity: catalogPin, ...overrides,
});
const host = { platform: "linux" as const, arch: "x64" };

test("embedded qualified pins only use promotable scopes", () => {
  for (const pin of qualifiedPins) {
    const rule = promotionRules[pin.backend];
    assert.ok(rule, `${pin.backend} cannot be promoted`);
    assert.equal(pin.executionMode, rule.executionMode);
    assert.equal(pin.acceleration, rule.acceleration);
  }
  assert.equal(promotionRules.ollama, undefined);
  assert.equal(promotionRules.vllm, undefined);
  assert.equal(promotionRules["mlx-lm"], undefined);
  assert.equal(promotionRules.libvirt, undefined);
  assert.equal(promotionRules["apple-virtualization"], undefined);
});

test("promotion requires the backend, host OS, architecture, scope and identity to match", () => {
  const match = (pins: QualifiedPin[], env: Pick<Environment, "platform" | "arch"> = host) =>
    promoted("llama.cpp", { ...env, qualifiedPins: pins }, identity => identity.version === "1.2.3");
  assert.equal(match([]), false);
  assert.equal(match([llama()]), true);
  assert.equal(match([llama()], { platform: "linux", arch: "arm64" }), false);
  assert.equal(match([llama()], { platform: "darwin", arch: "x64" }), false);
  assert.equal(match([llama()], { platform: "win32", arch: "x64" }), false);
  assert.equal(match([llama({ acceleration: "cuda" })]), false);
  assert.equal(match([llama({ executionMode: "detect-only" })]), false);
  assert.equal(match([llama({ identity: { version: "1.2.4" } })]), false);
  assert.equal(promoted("ollama", { ...host, qualifiedPins: [llama({ backend: "ollama" })] }, () => true), false);
});

test("containerd promotion compares every receipt asset", () => {
  const assets = [{ name: "containerd", version: "2.4.2", sha256: digest }, { name: "runc", version: "1.5.3", sha256: digest }];
  const pin: QualifiedPin = { backend: "containerd", os: "linux", arch: "x86_64", acceleration: "none", executionMode: "root-lifecycle",
    pinId: "2.4.2-000000000000000000000000", identity: { version: "2.4.2", assets: assets.map(asset => ({ ...asset, url: "https://example.invalid", bytes: 1 })) } };
  const env = { ...host, qualifiedPins: [pin] };
  assert.equal(containerdPromoted(env, assets), true);
  assert.equal(containerdPromoted({ ...host, qualifiedPins: [] }, assets), false);
  assert.equal(containerdPromoted(env, [assets[0]!, { ...assets[1]!, sha256: "b".repeat(64) }]), false);
  assert.equal(containerdPromoted(env, [...assets, { name: "cni-plugins", version: "1.0.0", sha256: digest }]), false);
});

test("model engines are qualified only when the executor and the embedded table agree", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-runtimes-qualification-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "executor"), config = join(root, "config", "executor.json");
  mkdirSync(join(root, "config"));
  writeFileSync(config, "{}");
  const report = (qualified: boolean, pin: unknown = catalogPin, active = true) => ({
    type: "canaveral-runtime-report", version: 1, operation: "status", platform: "linux", arch: "x86_64", dryRun: false,
    backends: modelIds.map((backend, index) => ({
      backend, catalogVersion: "1.2.3", available: index < 2, state: index === 1 ? "verified" : index < 2 ? "absent" : "unavailable",
      installed: index === 1 && active ? [{ version: "1.2.3", packageDigest: digest, verified: true, referenced: false }] : [],
      qualified: index === 1 && qualified, ...(index === 1 && active ? { active: "1.2.3" } : {}),
      ...(index === 1 && pin !== null ? { catalogPin: pin } : {}),
    })),
  });
  const script = (value: unknown) => writeFileSync(binary, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(value))});`, { mode: 0o755 });
  const env: Partial<Environment> = {
    ...host, receipt: () => undefined,
    lstat: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    run: (argv, timeout, max) => argv[0] === binary ? run(argv, timeout, max) : Promise.reject(new ProbeError("runtime_probe_missing")),
    modelStat: path => path === root || path.startsWith(root + "/") ? lstatSync(path)
      : { uid: 0, mode: 0o755, nlink: 1, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false },
  };
  const settings = { modelExecutor: { binary, config } };
  const llamaRow = async (reported: boolean, pins: QualifiedPin[], pin: unknown = catalogPin, active = true) => {
    script(report(reported, pin, active));
    return (await runtimeInventory(settings, { ...env, qualifiedPins: pins })).find(row => row.id === "llama.cpp");
  };
  assert.equal((await llamaRow(true, [llama()]))?.qualified, true);
  assert.equal((await llamaRow(false, [llama()]))?.qualified, false);
  assert.equal((await llamaRow(true, []))?.qualified, false);
  assert.equal((await llamaRow(true, [llama({ identity: { ...catalogPin, packageDigest: "b".repeat(64) } })]))?.qualified, false);
  assert.equal((await llamaRow(true, [llama({ arch: "aarch64" })]))?.qualified, false);
  // With no active package, a promotion must still match the full pin, never the version alone.
  assert.equal((await llamaRow(true, [llama()], catalogPin, false))?.qualified, true);
  assert.equal((await llamaRow(true, [llama({ identity: { ...catalogPin, sha256: "d".repeat(64) } })], catalogPin, false))?.qualified, false);
  assert.equal((await llamaRow(true, [llama({ identity: { version: "1.2.3" } })], catalogPin, false))?.qualified, false);
  // A qualified claim without the full catalog pin, or with an inconsistent one, violates the contract.
  assert.equal((await llamaRow(true, [llama()], null))?.blocker?.code, "model_executor_invalid_report");
  assert.equal((await llamaRow(true, [llama()], { ...catalogPin, version: "9.9.9" }))?.blocker?.code, "model_executor_invalid_report");
  assert.equal((await llamaRow(false, [llama()], { ...catalogPin, extra: "x" }))?.blocker?.code, "model_executor_invalid_report");
});

test("VM backends stay unqualified even with a matching table entry", async () => {
  const libvirtEnv = (pins: QualifiedPin[]): Partial<Environment> => ({
    ...host, receipt: () => undefined, qualifiedPins: pins,
    lstat: path => {
      if (path === "/dev/kvm") return { isCharacterDevice: () => true };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    run: async () => ({ stdout: "version 10.0.0", exit: 0 }),
  });
  const libvirt: QualifiedPin = { backend: "libvirt", os: "linux", arch: "x86_64", acceleration: "kvm", executionMode: "vm-boot",
    pinId: "10.0.0-000000000000000000000000", identity: { version: "10.0.0", source: "host-packages" } };
  const verified = (await runtimeInventory({}, libvirtEnv([libvirt])))[1];
  assert.equal(verified?.state, "verified");
  assert.equal(verified?.qualified, false);

  const runner = "/opt/canaveral/CanaveralVMRunner";
  const apple: QualifiedPin = { backend: "apple-virtualization", os: "macos", arch: "aarch64", acceleration: "vz", executionMode: "vm-boot",
    pinId: "26.1-000000000000000000000000", identity: { version: "26.1", source: "host-os" } };
  const appleEnv = (pins: QualifiedPin[]): Partial<Environment> => ({
    platform: "darwin", arch: "arm64", qualifiedPins: pins, lstat: () => ({ isCharacterDevice: () => false }),
    run: async argv => {
      if (argv[0] === "/usr/bin/sw_vers") return { stdout: "26.1", exit: 0 };
      if (argv.includes("--entitlements")) return { stdout: "<key>com.apple.security.virtualization</key><true/>", exit: 0 };
      return { stdout: "Apple virtualization available", exit: 0 };
    },
  });
  const config = { runtimes: { apple: { runner } } };
  const appleRow = (await runtimeInventory(config, appleEnv([apple])))[0];
  assert.equal(appleRow?.state, "verified");
  assert.equal(appleRow?.qualified, false);
});
