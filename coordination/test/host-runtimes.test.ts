import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { main } from "../src/cli.ts";
import { checkHost } from "../src/host.ts";
import { backendIds, modelConfig, mutateRuntime, runtimeInventory } from "../src/host-runtimes/index.ts";
import { modelIds, ProbeError, run } from "../src/host-runtimes/core.ts";
import type { Environment } from "../src/host-runtimes/core.ts";
import { installerInstruction, readReceipt } from "../src/host-runtimes/native.ts";

function directory(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-runtimes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const digest = "1".repeat(64);
const receipt = {
  type: "canaveral-host-installer-receipt", version: 1, component: "containerd", installedAt: 1,
  assets: ["containerd", "runc"].map(name => ({ name, version: "1.2.3", sha256: digest })),
  files: [{ path: "/opt/canaveral/bin/containerd", sha256: digest }],
  unit: "/etc/systemd/system/canaveral-containerd.service", socket: "/run/canaveral-containerd/containerd.sock",
};
const absent = () => { throw Object.assign(new Error("Missing fixture path"), { code: "ENOENT" }); };
const linux: Partial<Environment> = {
  platform: "linux", arch: "x64", receipt: () => undefined, lstat: absent,
  run: async () => { throw new ProbeError("runtime_probe_missing"); },
};

test("registry returns every backend and reports platform, prerequisites and conflicts", async () => {
  const initial = await runtimeInventory({}, linux);
  assert.deepEqual(initial.map(b => b.id), backendIds);
  assert.deepEqual(initial.map(b => b.state), ["unavailable", "absent", "absent", ...modelIds.map(() => "unavailable")]);
  assert.equal(initial[3]?.blocker?.code, "model_executor_not_configured");
  const found = await runtimeInventory({}, {
    ...linux, receipt: () => receipt,
    lstat: path => {
      if (path === "/dev/kvm") return { isCharacterDevice: () => true };
      if (path === "/run/docker.sock") return { isCharacterDevice: () => false };
      return absent();
    },
    run: async argv => {
      assert.ok(["virsh", "qemu-img", "qemu-system-x86_64"].includes(argv[0]!));
      if (argv[1] === "--connect") assert.deepEqual(argv, ["virsh", "--connect", "qemu:///system", "domcapabilities", "--virttype", "kvm"]);
      return { stdout: "version 1.2.3", exit: 0 };
    },
  });
  assert.equal(found[1]?.state, "verified");
  assert.equal(found[2]?.state, "installed");
  assert.equal(found[2]?.blocker?.code, "containerd_foreign_install");
  assert.ok(found.every(b => b.qualified === false));
  const bad = await runtimeInventory({}, { ...linux, receipt: () => ({ ...receipt, files: [{ path: "/opt/../unsafe", sha256: digest }] }) });
  assert.equal(bad[2]?.state, "unknown");
  assert.equal(bad[2]?.blocker?.code, "containerd_receipt_invalid");
});

test("receipt read refuses symlinked directories, linked files and unsafe modes", t => {
  const root = directory(t), dir = join(root, "receipts"), path = join(dir, "containerd.json"), owner = process.getuid!();
  mkdirSync(dir);
  const inspect: typeof lstatSync = ((target: string) => target.toString().startsWith(root)
    ? lstatSync(target) : { isDirectory: () => true, uid: owner, mode: 0o755 }) as typeof lstatSync;
  const read = (target = path) => readReceipt(target, owner, inspect);
  assert.equal(read(), undefined);
  writeFileSync(path, JSON.stringify(receipt), { mode: 0o644 });
  assert.deepEqual(read(), receipt);
  const linked = join(root, "link");
  symlinkSync(dir, linked);
  assert.throws(() => read(join(linked, "containerd.json")), /containerd_receipt_invalid/);
  const file = join(dir, "link");
  symlinkSync(path, file);
  assert.throws(() => read(file), /containerd_receipt_invalid/);
  linkSync(path, join(dir, "hardlink"));
  assert.throws(() => read(), /containerd_receipt_invalid/);
  const unsafe = join(dir, "unsafe");
  writeFileSync(unsafe, JSON.stringify(receipt), { mode: 0o666 });
  // Apply an explicit unsafe mode even under the test runner's umask.
  chmodSync(unsafe, 0o600);
  assert.throws(() => read(unsafe), /containerd_receipt_invalid/);
});

test("Apple probes OS, signature, entitlement and the existing runner check", async () => {
  const runner = "/opt/canaveral/CanaveralVMRunner";
  const config = { runtimes: { apple: { runner } } };
  const env: Partial<Environment> = {
    platform: "darwin", arch: "arm64", lstat: () => ({ isCharacterDevice: () => false }),
    run: async argv => {
      if (argv[0] === "/usr/bin/sw_vers") return { stdout: "26.1", exit: 0 };
      if (argv.includes("--entitlements")) return { stdout: "<key>com.apple.security.virtualization</key><true/>", exit: 0 };
      if (argv[0] === runner) assert.deepEqual(argv, [runner, "check"]);
      return { stdout: "Apple virtualization available", exit: 0 };
    },
  };
  assert.equal((await runtimeInventory(config, env))[0]?.state, "verified");
  const failed = await runtimeInventory(config, { ...env, run: async () => ({ stdout: "26.0", exit: 0 }) });
  assert.equal(failed[0]?.state, "failed");
  assert.equal(failed[0]?.blocker?.code, "apple_entitlement_missing");
});

function executor(t: TestContext) {
  const root = directory(t);
  const binary = join(root, "executor"), config = join(root, "executor.json");
  writeFileSync(config, "{}");
  const settings = { modelExecutor: { binary, config } };
  const script = (body: string) => writeFileSync(binary, "#!" + process.execPath + "\n" + body, { mode: 0o755 });
  const rows = modelIds.map((backend, index) => ({
    backend, catalogVersion: "1.2.3", available: index < 2, state: ["verified", "absent", "unavailable", "unavailable"][index],
    installed: index === 0 ? [{ version: "1.2.3", packageDigest: digest, verified: true, referenced: false }] : [],
    qualified: false,
  }));
  const plan = { downloadBytes: 4, assets: [{ url: "https://example.invalid/model", bytes: 4, sha256: digest }] };
  const report = { type: "canaveral-runtime-report", version: 1, platform: "linux", arch: "x86_64", dryRun: false, backends: rows };
  const invoke: Environment["run"] = (argv, timeout, max) => argv[0] === binary ? run(argv, timeout, max) : linux.run!(argv, timeout, max);
  return { settings, binary, root, script, report, plan, invoke };
}

test("executor uses fixed argv and returns plans, verification and retained-version failures", async t => {
  const f = executor(t);
  const install = ["--runtime-prepare", "--config", f.settings.modelExecutor.config, "--backend", "ollama", "--dry-run"];
  const remove = ["--runtime-remove", "--config", f.settings.modelExecutor.config, "--backend", "ollama", "--version", "1.2.3"];
  const verify = ["--runtime-verify", "--config", f.settings.modelExecutor.config, "--backend", "ollama"];
  for (const [action, operation, args, dryRun, selected] of [
    ["install", "prepare", install, true, undefined], ["remove", "remove", remove, false, "1.2.3"], ["verify", "verify", verify, false, undefined],
  ] as const) {
    const result = action === "remove" ? { state: "failed", code: "runtime_in_use" } : { state: "succeeded" };
    const plan = action === "verify" ? {} : { plan: f.plan };
    const report = { ...f.report, operation, dryRun, ...plan, result };
    f.script(`if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))}) process.exit(2);
console.log(${JSON.stringify(JSON.stringify(report))}); process.exitCode = ${action === "remove" ? 1 : 0};`);
    const observed = await mutateRuntime(f.settings, action, "ollama", dryRun, selected, { ...linux, run: f.invoke });
    assert.deepEqual(observed.result, result);
    assert.equal(observed.backends[0]?.state, "verified");
    assert.deepEqual(observed.plan, plan.plan);
  }
});

test("bounded executor rejects timeout, oversize output and contract violations", async t => {
  const f = executor(t);
  const env = { ...linux, run: (argv: readonly string[], _timeout: number, max: number) => f.invoke(argv, 1_000, max) };
  f.script("setInterval(() => {}, 1000);");
  assert.equal((await runtimeInventory(f.settings, env))[3]?.blocker?.code, "runtime_probe_timeout");
  f.script('console.log("a".repeat(300000));');
  assert.equal((await runtimeInventory(f.settings, env))[3]?.blocker?.code, "runtime_probe_output_limit");
  const status = { ...f.report, operation: "status" };
  for (const invalid of [{ ...status, version: 2 }, { ...status, backends: [] }, { ...status, arch: "aarch64" },
    { ...status, backends: status.backends.map(row => ({ ...row, qualified: true })) }]) {
    f.script(`console.log(${JSON.stringify(JSON.stringify(invalid))});`);
    const rows = await runtimeInventory(f.settings, env);
    assert.equal(rows[3]?.state, "unknown");
    assert.equal(rows[3]?.blocker?.code, "model_executor_invalid_report");
  }
  f.script(`console.log(${JSON.stringify(JSON.stringify(status))});`);
  assert.equal((await runtimeInventory(f.settings, env))[3]?.state, "verified");
  const linked = join(f.root, "linked");
  symlinkSync(f.binary, linked);
  assert.throws(() => modelConfig({ modelExecutor: { ...f.settings.modelExecutor, binary: linked } }), /without links/);
  assert.throws(() => modelConfig({ modelExecutor: { ...f.settings.modelExecutor, binary: "executor" } }), /absolute paths/);
});

test("daemon CLI and inventory expose the registry without contacting the controller", async t => {
  const root = directory(t), state = join(root, "state"), file = join(root, "host.json");
  const config = { name: "fixture", provider: "native", templates: [], capacity: { cpu: 1, memoryMiB: 1024, diskGiB: 1 } };
  writeFileSync(file, JSON.stringify(config));
  const flags = ["--config", file, "--state", state];
  let output = "", errors = "";
  const io = { stdout: (s: string) => { output += s; }, stderr: (s: string) => { errors += s; }, client: () => { throw new Error("Controller contact"); } };
  assert.equal(await main(["runtimes", "status", ...flags, "--json"], io, "canaverald"), 0);
  assert.deepEqual(JSON.parse(output).map((entry: { id: string }) => entry.id), backendIds);
  output = "";
  assert.equal(await main(["runtimes", "install", "containerd", ...flags], io, "canaverald"), 1);
  assert.ok(output.includes(installerInstruction));
  assert.equal(errors, "");
  output = "";
  assert.equal(await main(["runtimes", "verify", "libvirt", ...flags, "--json"], io, "canaverald"), 1);
  assert.equal(JSON.parse(output).result.code, "runtime_detect_only");
  assert.throws(() => lstatSync(state), /ENOENT/);
  const inventory = await checkHost({ ...config, stateDir: state, url: "https://offline.invalid" }, {
    platform: "linux",
    transport: { request: async () => { throw new Error("Controller contact"); } },
    providerFactory: () => ({ kind: "native", check: async () => ({}), reconcile: async () => ({}) }),
  }, true);
  assert.deepEqual((inventory.runtimes as { id: string }[]).map(entry => entry.id), backendIds);
  assert.ok(!Object.hasOwn(inventory.offer as object, "runtimes"));
});
