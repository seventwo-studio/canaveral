import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { main } from "../src/cli.ts";
import { checkHost } from "../src/host.ts";
import { backendIds, modelConfig, mutateRuntime, runtimeInventory } from "../src/host-runtimes/index.ts";
import { modelIds, ProbeError, run } from "../src/host-runtimes/core.ts";
import type { Environment } from "../src/host-runtimes/core.ts";
import { readReceipt } from "../src/host-runtimes/native.ts";

function directory(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-runtimes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const digest = "1".repeat(64);
const receipt = {
  type: "canaveral-host-installer-receipt", version: 1, component: "containerd", installedAt: 1,
  assets: ["containerd", "runc"].map(name => ({ name, version: "1.2.3", sha256: digest })),
  files: [
    "/etc/systemd/system/canaveral-containerd.service",
    "/etc/canaveral-containerd/config.toml",
    ...["containerd", "containerd-shim-runc-v2", "ctr", "runc"].map(name => `/opt/canaveral-containerd/1.2.3/bin/${name}`),
  ].map(path => ({ path, sha256: digest })),
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
    const binary = join(root, "executor"), config = join(root, "config", "executor.json");
  mkdirSync(dirname(config));
  writeFileSync(config, "{}");
  const settings = { modelExecutor: { binary, config } };
  const script = (body: string) => writeFileSync(binary, "#!" + process.execPath + "\n" + body, { mode: 0o755 });
  const rows = modelIds.map((backend, index) => ({
    backend, catalogVersion: "1.2.3", available: index < 2, state: ["verified", "absent", "unavailable", "unavailable"][index],
    installed: index === 0 ? [{ version: "1.2.3", packageDigest: digest, verified: true, referenced: true }] : [],
    qualified: false,
  }));
  const plan = { downloadBytes: 4, assets: [{ url: "https://example.invalid/model", bytes: 4, sha256: digest }] };
  const report = { type: "canaveral-runtime-report", version: 1, platform: "linux", arch: "x86_64", dryRun: false, backends: rows };
  const invoke: Environment["run"] = (argv, timeout, max) => argv[0] === binary ? run(argv, timeout, max) : linux.run!(argv, timeout, max);
  const modelStat: NonNullable<Environment["modelStat"]> = path => {
    if (path === root || path.startsWith(root + "/")) return lstatSync(path);
    // The test harness uses a system temporary directory.
    return { uid: 0, mode: 0o755, nlink: 1, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
  };
  return { settings, binary, root, script, report, plan, invoke, modelStat };
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
    const report = { ...f.report, operation, dryRun, backends: f.report.backends.slice(0, 1), ...plan, result };
    f.script(`if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))}) process.exit(2);
console.log(${JSON.stringify(JSON.stringify(report))}); process.exitCode = ${action === "remove" ? 1 : 0};`);
    const observed = await mutateRuntime(f.settings, action, "ollama", dryRun, selected, { ...linux, run: f.invoke, modelStat: f.modelStat });
    assert.deepEqual(observed.result, result);
    assert.equal(observed.backends[0]?.state, "verified");
    assert.deepEqual(observed.backends[0]?.installed, report.backends[0]?.installed);
    assert.deepEqual(observed.plan, plan.plan);
  }
});

test("bounded executor rejects timeout, oversize output and contract violations", async t => {
  const f = executor(t);
  const env = { ...linux, modelStat: f.modelStat, run: (argv: readonly string[], _timeout: number, max: number) => f.invoke(argv, 1_000, max) };
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
  const qualified = { ...status, backends: status.backends.map(row => row.backend === "ollama"
    ? { ...row, qualified: true, active: "1.2.3" } : row) };
  f.script(`console.log(${JSON.stringify(JSON.stringify(qualified))});`);
  const installed = (await runtimeInventory(f.settings, env))[3];
  assert.equal(installed?.state, "verified");
  assert.equal(installed?.active, "1.2.3");
  assert.equal(installed?.catalogVersion, "1.2.3");
  assert.equal(installed?.qualified, true);
  assert.deepEqual(installed?.installed, status.backends[0]?.installed);
  const linked = join(f.root, "linked");
  symlinkSync(f.binary, linked);
  assert.throws(() => modelConfig({ modelExecutor: { ...f.settings.modelExecutor, binary: linked } }, f.modelStat), /without links/);
  assert.throws(() => modelConfig({ modelExecutor: { ...f.settings.modelExecutor, binary: "executor" } }), /absolute paths/);
});

// Captured from canaveral-model-execution at f7b0d6c on macOS arm64.
const executorReports = {
  status: { exit: 0, stdout: "{\"arch\":\"aarch64\",\"backends\":[{\"available\":true,\"backend\":\"ollama\",\"catalogVersion\":\"0.40.17\",\"installed\":[],\"qualified\":false,\"state\":\"absent\"},{\"available\":true,\"backend\":\"llama.cpp\",\"catalogVersion\":\"1.0.0\",\"installed\":[],\"qualified\":false,\"state\":\"absent\"},{\"available\":false,\"backend\":\"vllm\",\"blocker\":{\"code\":\"runtime_unavailable\",\"detail\":\"Hermetic package not yet qualified.\"},\"installed\":[],\"qualified\":false,\"state\":\"unavailable\"},{\"available\":false,\"backend\":\"mlx-lm\",\"blocker\":{\"code\":\"runtime_unavailable\",\"detail\":\"Hermetic package not yet qualified.\"},\"installed\":[],\"qualified\":false,\"state\":\"unavailable\"}],\"dryRun\":false,\"operation\":\"status\",\"platform\":\"macos\",\"type\":\"canaveral-runtime-report\",\"version\":1}\n" },
  prepare: { exit: 0, stdout: "{\"arch\":\"aarch64\",\"backends\":[{\"available\":true,\"backend\":\"ollama\",\"catalogVersion\":\"0.40.17\",\"installed\":[],\"qualified\":false,\"state\":\"absent\"}],\"dryRun\":true,\"operation\":\"prepare\",\"plan\":{\"assets\":[{\"bytes\":187626746,\"sha256\":\"4b9db20d077c5a1e52fb4a6f2e6791f76ae945fd07c9b1a5647c82e927826653\",\"url\":\"https://github.com/ollama/ollama/releases/download/v0.40.17/ollama-darwin.tgz\"}],\"downloadBytes\":187626746},\"platform\":\"macos\",\"result\":{\"state\":\"succeeded\"},\"type\":\"canaveral-runtime-report\",\"version\":1}\n" },
  remove: { exit: 0, stdout: "{\"arch\":\"aarch64\",\"backends\":[{\"available\":true,\"backend\":\"ollama\",\"catalogVersion\":\"0.40.17\",\"installed\":[],\"qualified\":false,\"state\":\"absent\"}],\"dryRun\":true,\"operation\":\"remove\",\"plan\":{\"assets\":[],\"downloadBytes\":0},\"platform\":\"macos\",\"result\":{\"state\":\"succeeded\"},\"type\":\"canaveral-runtime-report\",\"version\":1}\n" },
  verify: { exit: 1, stdout: "{\"arch\":\"aarch64\",\"backends\":[{\"available\":true,\"backend\":\"ollama\",\"catalogVersion\":\"0.40.17\",\"installed\":[],\"qualified\":false,\"state\":\"absent\"}],\"dryRun\":false,\"operation\":\"verify\",\"platform\":\"macos\",\"type\":\"canaveral-runtime-report\",\"version\":1}\n" },
};

test("registry accepts captured Rust reports for status, dry-run mutations and absent verify", async t => {
  const f = executor(t);
  f.script("");
  const env: Partial<Environment> = {
    ...linux, platform: "darwin", arch: "arm64", modelStat: f.modelStat,
    run: (argv, timeout, max) => {
      if (argv[0] !== f.binary) return f.invoke(argv, timeout, max);
      const operation = argv[1]?.slice("--runtime-".length) as keyof typeof executorReports;
      return Promise.resolve(executorReports[operation]);
    },
  };
  const inventory = await runtimeInventory(f.settings, env);
  assert.deepEqual(inventory.slice(3).map(b => b.state), ["absent", "absent", "unavailable", "unavailable"]);
  assert.equal(inventory[5]?.blocker?.code, "runtime_unavailable");

  const prepare = await mutateRuntime(f.settings, "install", "ollama", true, undefined, env);
  assert.equal(prepare.result?.state, "succeeded");
  assert.equal(prepare.plan?.downloadBytes, 187626746);
  const remove = await mutateRuntime(f.settings, "remove", "ollama", true, "0.40.17", env);
  assert.equal(remove.result?.state, "succeeded");
  assert.deepEqual(remove.plan, { assets: [], downloadBytes: 0 });
  const verify = await mutateRuntime(f.settings, "verify", "ollama", false, undefined, env);
  assert.deepEqual(verify.result, { state: "failed" });
  assert.equal(verify.backends[0]?.state, "absent");
  assert.equal(verify.plan, undefined);

  // Rust retains a damaged current package in inventory with verified=false and omits active.
  const status = JSON.parse(executorReports.status.stdout);
  const integrity = {
    code: "runtime_integrity_failed", detail: "The installed runtime failed verification.",
    action: "Remove the unused package version and prepare it again.",
  };
  Object.assign(status.backends[0], {
    state: "failed", blocker: integrity,
    installed: [{ version: "0.40.17", packageDigest: digest, verified: false, referenced: false }],
  });
  const damaged = await runtimeInventory(f.settings, {
    ...env, run: (argv, timeout, max) => argv[0] === f.binary
      ? Promise.resolve({ stdout: JSON.stringify(status) + "\n", exit: 1 }) : f.invoke(argv, timeout, max),
  });
  assert.equal(damaged[3]?.state, "failed");
  assert.deepEqual(damaged[3]?.blocker, integrity);
  assert.deepEqual(damaged.slice(4), inventory.slice(4));
});

test("executor files and both parent chains require trusted owners, modes and types", t => {
  const f = executor(t);
  f.script("");
  const { binary, config } = f.settings.modelExecutor;
  const owner = lstatSync(binary).uid;
  assert.deepEqual(modelConfig(f.settings, f.modelStat), f.settings.modelExecutor);
  for (const [target, unsafe] of [
    [binary, { uid: owner + 1 }],
    [config, { mode: 0o640 | 0o002 }],
    [config, { nlink: 2 }],
    [f.root, { mode: 0o775 }],
    [dirname(config), { uid: owner + 1 }],
    [dirname(f.root), { mode: 0o1777 }],
    [dirname(f.root), { uid: owner + 1 }],
    [dirname(f.root), { isSymbolicLink: () => true }],
    ["/", { mode: 0o757 }],
  ] as const) {
    assert.throws(() => modelConfig(f.settings, path => {
      const info = f.modelStat(path);
      return path === target ? Object.assign(info, unsafe) : info;
    }), /owned by root or the daemon user/);
  }
});

test("native mutation refusals preserve detected state and reject unsupported platforms", async () => {
  const env = { ...linux, receipt: () => undefined };
  const status = await runtimeInventory({}, env);
  for (const action of ["install", "verify", "remove"] as const) {
    const container = await mutateRuntime({}, action, "containerd", false, undefined, env);
    assert.deepEqual(container.backends, [status[2]]);
    assert.equal(container.result?.code, "containerd_root_installer_required");
    assert.match(container.backends[0]?.blocker?.detail ?? "", /sudo canaveral-host-installer containerd install/);
    const libvirt = await mutateRuntime({}, action, "libvirt", false, undefined, env);
    assert.deepEqual(libvirt.backends, [status[1]]);
    assert.equal(libvirt.result?.code, "runtime_detect_only");
    for (const id of ["apple-virtualization", "containerd", "libvirt"] as const) {
      const unsupported = await mutateRuntime({}, action, id, false, undefined, { ...linux, arch: "ia32" });
      assert.equal(unsupported.backends[0]?.state, "unavailable");
      assert.equal(unsupported.backends[0]?.blocker?.code, "runtime_platform_unsupported");
      assert.equal(unsupported.result?.code, "runtime_platform_unsupported");
    }
  }
});

test("containerd mutations preserve unknown receipt-backed status when a system path is unreadable", async t => {
  const env: Partial<Environment> = {
    ...linux, receipt: () => receipt,
    lstat: () => { throw Object.assign(new Error("Permission denied"), { code: "EACCES" }); },
  };
  const status = (await runtimeInventory({}, env)).find(backend => backend.id === "containerd");
  assert.equal(status?.state, "unknown");
  assert.equal(status.blocker?.code, "runtime_probe_failed");
  const run = t.mock.fn(async () => assert.fail("containerd mutation invoked a command"));
  for (const action of ["install", "verify", "remove"] as const) {
    const response = await mutateRuntime({}, action, "containerd", false, undefined, { ...env, run });
    assert.deepEqual(response.backends, [status]);
    assert.deepEqual(response.result, { state: "failed", code: "containerd_root_installer_required" });
  }
  assert.equal(run.mock.callCount(), 0);
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
  const linuxHost = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
  assert.ok(output.includes(linuxHost ? "containerd_root_installer_required" : "runtime_platform_unsupported"));
  assert.equal(errors, "");
  output = "";
  assert.equal(await main(["runtimes", "verify", "libvirt", ...flags, "--json"], io, "canaverald"), 1);
  assert.equal(JSON.parse(output).result.code, linuxHost ? "runtime_detect_only" : "runtime_platform_unsupported");
  assert.throws(() => lstatSync(state), /ENOENT/);
  const inventory = await checkHost({ ...config, stateDir: state, url: "https://offline.invalid" }, {
    platform: "linux",
    transport: { request: async () => { throw new Error("Controller contact"); } },
    providerFactory: () => ({ kind: "native", check: async () => ({}), reconcile: async () => ({}) }),
  }, true);
  assert.deepEqual((inventory.runtimes as { id: string }[]).map(entry => entry.id), backendIds);
  assert.ok(!Object.hasOwn(inventory.offer as object, "runtimes"));
});

test("Kubernetes runtime commands refuse containerd before touching host receipts", async () => {
  const config = { deployment: "kubernetes", provider: "native" };
  const env = { ...linux, receipt: () => assert.fail("Probed containerd receipt in the pod"), lstat: () => assert.fail("Probed host runtime path") };
  const backends = await runtimeInventory(config, env);
  assert.equal(backends.find(backend => backend.id === "containerd")?.blocker?.code, "kubernetes_containerd_disabled");
  for (const action of ["install", "verify", "remove"] as const) {
    const report = await mutateRuntime(config, action, "containerd", false, undefined, env);
    assert.deepEqual(report.result, { state: "failed", code: "kubernetes_containerd_disabled" });
  }
});

test("Kubernetes runtime status inspects the mounted libvirt endpoint without local QEMU", async () => {
  const commands: string[][] = [];
  const backends = await runtimeInventory({
    deployment: "kubernetes", provider: "linux", runtimes: { libvirt: { socketPath: "/run/libvirt/host-sock" } },
  }, {
    ...linux,
    run: async argv => { commands.push([...argv]); return { stdout: "version 1.2.3", exit: 0 }; },
  });
  assert.equal(backends.find(backend => backend.id === "libvirt")?.state, "verified");
  assert.deepEqual(commands, [
    ["virsh", "--version"],
    ["qemu-img", "--version"],
    ["virsh", "--connect", "qemu+unix:///system?socket=/run/libvirt/host-sock", "domcapabilities", "--virttype", "kvm"],
    ["qemu-img", "--version"],
  ]);
});
