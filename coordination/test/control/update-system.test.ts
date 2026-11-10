import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startController } from "../../src/main.ts";
import { hostOffer, hostTransport } from "../../src/host.ts";
import type { HostConfig } from "../../src/host.ts";
import { canonicalManifest } from "../../src/updates/protocol.ts";
import type { Manifest, SignedRelease, Target } from "../../src/updates/protocol.ts";
import { ManagedUpdater, UpdateStore } from "../../src/updates/manager.ts";
import { StableLauncher } from "../../src/updates/launcher.ts";

test("signed rollout replaces the real idle host through the real controller and stable launcher", { timeout: 60_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-update-system-")));
  const hostState = join(root, "host-state"), updateState = join(root, "update-state"), installationRoot = join(root, "installation");
  for (const directory of [hostState, updateState, installationRoot]) mkdirSync(directory, { mode: 0o700 });
  const pair = generateKeyPairSync("ed25519");
  const keys = { fixture: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const target: Target = { os: process.platform as Target["os"], arch: process.arch === "x64" ? "amd64" : "arm64" };
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  const adminFile = join(root, "admin.token"), enrollmentFile = join(root, "enrollment.token"), configFile = join(root, "host.json");
  writeFileSync(adminFile, admin, { mode: 0o600 }); writeFileSync(enrollmentFile, enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: adminFile, enrollmentTokenFile: enrollmentFile,
    updatePublicKeys: keys, controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  let launcher: StableLauncher | undefined, updater: ManagedUpdater | undefined;
  t.after(async () => {
    await updater?.close();
    if (launcher) {
      try { await launcher.close(await launcher.quiesce()); }
      catch {
        // This fixture's only children are disposable Node hosts with no native runtimes.
        const owned = launcher as unknown as { current?: { child: import("node:child_process").ChildProcess }; pending?: { child: import("node:child_process").ChildProcess } };
        for (const process of [owned.current?.child, owned.pending?.child]) process?.kill("SIGKILL");
      }
    }
    await controller.close();
    function writable(directory: string): void {
      chmodSync(directory, 0o700);
      for (const item of readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) writable(join(directory, item.name));
    }
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  const hostId = randomUUID(), credential = randomBytes(32).toString("base64url");
  const config: HostConfig = { name: "update-fixture", provider: "native", templates: [], capacity: { cpu: 1, memoryMiB: 1024, diskGiB: 1 },
    url: `http://127.0.0.1:${controller.address.port}`, allowHTTP: true, stateDir: hostState, pollIntervalSeconds: 0.25,
    updates: { trustedKeys: keys, protectedPaths: [hostState, configFile] } };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const identity = JSON.stringify({ id: hostId, credential, orchestrator: config.url });
  writeFileSync(join(hostState, "identity.json"), identity, { mode: 0o600 });
  const transport = hostTransport(config);
  await transport.request("POST", "/v1/hosts/enroll", { id: hostId, credential, offer: hostOffer(config) }, enrollment);
  const source = join(root, "source"); mkdirSync(source, { mode: 0o700 });
  const payload = new Map<string, Buffer>();
  const emitted = fileURLToPath(new URL("../../src/", import.meta.url));
  function collect(directory: string, relative = ""): void {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) collect(join(directory, item.name), name);
      else if (item.isFile() && item.name.endsWith(".js")) payload.set(`coordination/dist/src/${name}`, readFileSync(join(directory, item.name)));
    }
  }
  collect(emitted); payload.set("coordination/package.json", Buffer.from('{"type":"module"}'));
  for (const [path, data] of payload) { mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(source, path), data, { mode: 0o600 }); }
  function release(sequence: number): SignedRelease {
    const manifest: Manifest = { schema: "canaveral-update-v1", releaseId: randomUUID(), version: `1.0.${sequence}`, sequence, createdAt: 1000, target,
      minimumLauncherVersion: 1, entrypoint: "coordination/dist/src/cli.js", files: [...payload].map(([path, bytes]) => ({ path, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), executable: false, component: "host" as const })) };
    return { manifest, keyId: "fixture", signature: sign(null, canonicalManifest(manifest), pair.privateKey).toString("base64") };
  }
  const baseline = release(1), candidate = release(2), settings = { installationRoot, stateDirectory: updateState, trustedKeys: keys, target, protectedPaths: [hostState, configFile], minimumFreeBytes: 0 };
  const initial = new UpdateStore(settings); await initial.installInitial(baseline, source);
  launcher = new StableLauncher({ ...settings, hostConfigPath: configFile, hostStateDirectory: hostState, readinessTimeoutMs: 10_000, stopTimeoutMs: 10_000 });
  await launcher.start();
  updater = new ManagedUpdater({ ...settings, identity: () => ({ id: hostId, credential }),
    request: (method, path, body, token, signal) => transport.request(method, path, body, token, signal),
    lifecycle: { idle: () => launcher!.idle(), quiesce: () => launcher!.quiesce(), activation: launcher } });
  assert.equal(await updater.poll(), undefined); // Register exact installation and baseline first.
  await transport.request("POST", "/v1/updates/releases", candidate as unknown as Record<string, unknown>, admin);
  for (const file of candidate.manifest.files) {
    const bytes = payload.get(file.path)!;
    for (let offset = 0; offset < bytes.length; offset += 262144) await transport.request("POST", `/v1/updates/artifacts/${file.sha256}`, {
      offset, totalBytes: bytes.length, data: bytes.subarray(offset, offset + 262144).toString("base64"),
    }, admin);
  }
  const rollout = randomUUID();
  await transport.request("POST", "/v1/updates/rollouts", { id: rollout, releaseId: candidate.manifest.releaseId, hostIds: [hostId] }, admin);
  await updater.poll();
  for (let attempt = 0; attempt < 30 && updater.store.job()?.phase !== "succeeded"; attempt++) {
    const job = await updater.step();
    assert.notEqual(job?.phase, "unknown"); assert.notEqual(job?.phase, "failed"); assert.notEqual(job?.phase, "rolledBack");
    if (job?.phase !== "succeeded") await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(updater.store.job()?.phase, "succeeded");
  assert.equal(updater.store.active(), candidate.manifest.releaseId);
  assert.equal(readFileSync(join(hostState, "identity.json"), "utf8"), identity);
  const view = await transport.request("GET", `/v1/updates/rollouts/${rollout}`, {}, admin);
  assert.equal((view.jobs as Array<{ state: string }>)[0]!.state, "succeeded");
});
