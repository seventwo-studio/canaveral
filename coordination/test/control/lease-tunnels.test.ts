import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startController } from "../../src/main.ts";
import { HostRunner, hostOffer } from "../../src/host.ts";
import type { HostConfig } from "../../src/host.ts";
import { AndroidProvider, LEASE_ISOLATION_ARGUMENTS } from "../../src/providers/android.ts";
import { parseMappings, tunnelStorageProblem } from "../../src/providers/android-tunnels.ts";
import { mobileNativeHelper, nativeLeaseSupervisor } from "../../src/providers/mobile-native.ts";
import type { CommandResult, MobileTransport, RecordValue, RunOptions } from "../../src/providers/mobile.ts";
import { MachineStore, validateOffer } from "../../src/control/machines.ts";
import { LeaseTunnels } from "../../src/control/lease-tunnels.ts";
import { initializeLeases } from "../../src/control/leases.ts";
import { createSessionUpgradeHandler, SessionConnection as PeerConnection } from "../../src/control/sessions.ts";
import { legacyDigest } from "../../src/control/templates.ts";
import { ConsumerIdentities } from "../../src/consumers.ts";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { loadHost } from "../../src/control/templates.ts";
import { fileURLToPath } from "node:url";
import { validateRelayMessage } from "../../src/control/session-protocol.ts";
import { consumerApiSchema, sessionProtocolSchema } from "../../src/contracts.ts";
import { main } from "../../src/cli.ts";
import { LeaseClient, LeaseTunnelClient, SessionConnection } from "../../src/sdk.ts";
import type { LeaseTunnel } from "../../src/sdk.ts";
import { TUNNEL_AUTHORITY_MS, TUNNEL_CONNECTIONS, TUNNEL_IDENTITIES_PER_HOUR, TUNNEL_OPEN_BURST, TUNNEL_OPENS_PER_SECOND, TUNNEL_RELAY_BYTES, TUNNEL_RELAY_OPENS, TUNNEL_RESIDUE_PER_LEASE, TUNNEL_WINDOW_BYTES, TunnelRelay, tunnelIntent } from "../../src/tunnel-relay.ts";
import type { TunnelChannel, TunnelEnd } from "../../src/tunnel-relay.ts";

/** Disposable lease-tunnel fixtures, in two groups.
 *
 * Component tests need nothing but Node and always run: the relay, the broker with a stand-in
 * control client, the controller module on a temporary database, and the packaged contracts.
 *
 * Integration tests use a real loopback controller, a real HostRunner with the native lease
 * clock and the real `lease-supervise` helper, and the real SDK relaying bytes between a stand-in
 * device and local servers. They need the built `canaveral-mobile-native` helper and are skipped
 * without it. CI's "TypeScript controller, SDK and guest services" job builds that helper before
 * `npm test`, so they run there; the first test below fails in CI if the helper is missing, so a
 * broken build path cannot turn them into silent skips.
 *
 * adb is a stand-in that keeps a live mapping registry and really connects mapped ports to the
 * runner's Unix sockets. No SDK, emulator or device is used, so nothing here establishes native
 * acceptance. */
const helper = mobileNativeHelper({});
const unix = ["darwin", "linux"].includes(process.platform);
const skip = !unix || !existsSync(helper) ? "requires the built canaveral-mobile-native helper" : false;
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const systemImage = `system-images;android-35;google_apis;${arch === "arm64" ? "arm64-v8a" : "x86_64"}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  assert.fail(`Timed out waiting for ${label}`);
}
/** Tunnel sockets live inside each lease's storage, so the fixture root must be short enough for a
 * Unix socket address. macOS's per-user temporary directory is not. */
function shortRoot(): string {
  for (const base of [tmpdir(), "/tmp"]) {
    const candidate = join(realpathSync(base), "cvt-XXXXXX", "d");
    if (!tunnelStorageProblem(candidate)) return realpathSync(mkdtempSync(join(realpathSync(base), "cvt-")));
  }
  throw new Error("No temporary directory is short enough for tunnel sockets.");
}

interface Emulator { name: string; port: number; pid: number; grandchild: number; bootedAt: number }
/** The stand-in device's port state: what `adb reverse`/`adb forward` would hold, apps that
 * listen on a device port, and device ports an app already bound. */
interface Device {
  reverse: Map<number, string>;
  forward: Map<string, { port: number; server: Server; sockets: Set<Socket>; accepted: number }>;
  services: Map<number, number>;
  busy: Set<number>;
}
interface Fixture {
  warmPool?: boolean;
  tunnels?: boolean; guest?: "isolated" | "leaky"; removeFails?: boolean;
  /** Raw lines appended to `forward --list`, which is server-wide: other devices, or odd output. */
  forwardNoise?: string;
  /** Host heartbeat interval in seconds; the default keeps the fixtures fast. */
  poll?: number;
}
function sdk(root: string): { sdk: string; registry: string } {
  const sdkRoot = join(root, "sdk"), registry = join(root, "emulators");
  for (const dir of ["platform-tools", "emulator", "cmdline-tools/latest/bin", ...systemImage.split(";").reduce<string[]>((paths, part) => [...paths, join(paths.at(-1) ?? "", part)], [])]) mkdirSync(join(sdkRoot, dir), { recursive: true });
  mkdirSync(registry);
  for (const tool of ["platform-tools/adb", "cmdline-tools/latest/bin/avdmanager"]) writeFileSync(join(sdkRoot, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const script = join(root, "fake-emulator.mjs");
  writeFileSync(script, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
const args = process.argv.slice(2), name = args[args.indexOf("-avd") + 1], port = Number(args[args.indexOf("-port") + 1]);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(registry)} + "/" + port + ".json", JSON.stringify({ name, port, pid: process.pid, grandchild: grandchild.pid, bootedAt: Date.now() + 300 }));
process.on("SIGTERM", () => { grandchild.kill("SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);\n`);
  writeFileSync(join(sdkRoot, "emulator/emulator"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { sdk: sdkRoot, registry };
}
function emulators(registry: string): Emulator[] {
  return readdirSync(registry).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(registry, name), "utf8")) as Emulator).filter(e => alive(e.pid));
}
function reach(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port }, () => { socket.destroy(); resolve(true); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}
function pipe(a: Socket, b: Socket): void {
  for (const [from, to] of [[a, b], [b, a]] as const) {
    from.on("data", data => { if (!to.write(data)) { from.pause(); to.once("drain", () => from.resume()); } });
    from.on("end", () => to.end()); from.on("error", () => to.destroy()); from.on("close", () => { if (!to.destroyed && !to.writableEnded) to.destroy(); });
  }
}
/** Fake adb and avdmanager. Mappings belong to the live stand-in emulator and vanish with it. */
function transport(paths: { sdk: string; registry: string }, counters: Map<string, number>, devices: Map<string, Device>, fixture: Fixture): MobileTransport {
  const ok = (stdout: string | Buffer): CommandResult => ({ stdout, exitCode: 0 }), failed: CommandResult = { stdout: "", exitCode: 1 };
  const device = (name: string): Device => {
    let state = devices.get(name);
    if (!state) { state = { reverse: new Map(), forward: new Map(), services: new Map(), busy: new Set() }; devices.set(name, state); }
    return state;
  };
  const sweep = (): Emulator[] => {
    const live = emulators(paths.registry);
    for (const [name, state] of devices) if (!live.some(e => e.name === name)) {
      for (const entry of state.forward.values()) { for (const socket of entry.sockets) socket.destroy(); entry.server.close(); }
      devices.delete(name);
    }
    return live;
  };
  return {
    async run(argv: readonly string[], options: RunOptions): Promise<CommandResult> {
      const tool = argv[0]!;
      if (tool.endsWith("avdmanager")) {
        const avd = argv[argv.indexOf("--path") + 1]!, name = argv[argv.indexOf("--name") + 1]!;
        mkdirSync(avd, { recursive: true }); writeFileSync(join(avd, "config.ini"), "hw.lcd.density=420\n");
        writeFileSync(join(options.env.ANDROID_AVD_HOME!, name + ".ini"), "path=" + avd + "\n");
        return ok("");
      }
      if (argv[1] === "start-server") return ok("");
      const live = sweep();
      if (argv[1] === "devices") return ok("List of devices attached\n" + live.map(e => `emulator-${e.port}\tdevice\n`).join(""));
      assert.equal(argv[1], "-s");
      const serial = argv[2]!, args = argv.slice(3), emulator = live.find(e => `emulator-${e.port}` === serial);
      if (!emulator) return failed;
      const state = device(emulator.name), key = `${emulator.name}:${args.join(" ")}`;
      counters.set(key, (counters.get(key) ?? 0) + 1);
      // A host that does not declare tunnels must never ask; there the stand-in refuses, as the
      // lease fixture on main does, so readiness cannot depend on these queries.
      if (!fixture.tunnels && args[1] === "--list") return failed;
      if (args[0] === "reverse") {
        if (args[1] === "--list") return ok([...state.reverse].map(([port, spec]) => `host-7 tcp:${port} ${spec}`).join("\n"));
        const port = Number(String(args[2]).replace(/^tcp:/, ""));
        if (args[1] === "--no-rebind") {
          // adbd cannot bind a port an app already holds, and --no-rebind refuses an existing mapping.
          if (state.reverse.has(port) || state.busy.has(port)) return failed;
          state.reverse.set(port, args[3]!); return ok(String(port));
        }
        if (args[1] === "--remove") return !fixture.removeFails && state.reverse.delete(port) ? ok("") : failed;
        return failed;
      }
      if (args[0] === "forward") {
        if (args[1] === "--list") return ok([...live.flatMap(e => [...(devices.get(e.name)?.forward ?? [])].map(([local, entry]) => `emulator-${e.port} ${local} tcp:${entry.port}`)), ...(fixture.forwardNoise ? [fixture.forwardNoise] : [])].join("\n"));
        if (args[1] === "--no-rebind") {
          const local = args[2]!, port = Number(String(args[3]).replace(/^tcp:/, ""));
          if (state.forward.has(local)) return failed;
          const sockets = new Set<Socket>();
          // The adb server listens on the host endpoint and opens one stream to the device port.
          const entry = { port, sockets, accepted: 0, server: undefined as unknown as Server };
          const server = entry.server = createServer({ allowHalfOpen: true }, socket => {
            entry.accepted++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
            const service = state.services.get(port);
            if (service === undefined) { socket.destroy(); return; }
            const upstream = connect({ host: "127.0.0.1", port: service, allowHalfOpen: true });
            upstream.on("error", () => socket.destroy()); pipe(socket, upstream);
          });
          await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(local.replace(/^localfilesystem:/, ""), () => resolve()); });
          state.forward.set(local, entry); return ok(String(port));
        }
        if (args[1] === "--remove") {
          const entry = state.forward.get(args[2]!);
          if (!entry) return failed;
          for (const socket of entry.sockets) socket.destroy();
          await new Promise<void>(resolve => { entry.server.close(() => resolve()); });
          try { unlinkSync(args[2]!.replace(/^localfilesystem:/, "")); } catch { /* the server already unlinked it */ }
          state.forward.delete(args[2]!); return ok("");
        }
        return failed;
      }
      if (args.join(" ") === "emu avd name") return ok(emulator.name + "\nOK");
      if (args.join(" ") === "shell getprop sys.boot_completed") return ok(Date.now() >= emulator.bootedAt ? "1" : "");
      if (args.join(" ") === "shell pm path android") return ok("package:/system/framework/framework-res.apk");
      if (args.join(" ") === "shell getprop ro.debuggable") return ok("0");
      if (args[0] === "shell" && args[1]?.includes("canaveral-isolation")) {
        const ports = /for p in ([0-9 ]+); do/.exec(args[1])![1]!.trim().split(" ").map(Number), lines: string[] = [];
        for (const port of ports) lines.push(fixture.guest === "leaky" && await reach(port) ? `canaveral-isolation ${port} 0 ` : `canaveral-isolation ${port} 1 nc: connect: Connection refused`);
        return ok(lines.join("\n") + "\ncanaveral-isolation-done\n");
      }
      if (args[0] === "shell" || args[0] === "logcat") return ok("ok");
      return failed;
    },
    async processAbsent(pid) { return !alive(pid); },
    async portPairAvailable(port) { return !emulators(paths.registry).some(e => e.port === port); },
    leases: nativeLeaseSupervisor,
  };
}

interface Harness {
  url: string; admin: string; enrollment: string; root: string; image: RecordValue; registry: string; counters: Map<string, number>; devices: Map<string, Device>; fixture: Fixture;
  runner(): HostRunner; restartRunner(): Promise<void>; stopController(): Promise<void>; startController(): Promise<void>;
  api(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
  application(tunnelsPerLease?: number): Promise<string>;
  storage(machineId: string): string;
  reserved(): Promise<RecordValue>;
  /** adb calls for one device whose arguments start with `prefix`. */
  calls(machineId: string, prefix: string): number;
  device(machineId: string): Device | undefined;
}
async function harness(t: TestContext, capacity = 1, fixture: Fixture = { tunnels: true }): Promise<Harness> {
  const root = shortRoot();
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  writeFileSync(join(root, "admin"), admin, { mode: 0o600 }); writeFileSync(join(root, "enroll"), enrollment, { mode: 0o600 });
  const paths = sdk(root), counters = new Map<string, number>(), devices = new Map<string, Device>();
  const image: RecordValue = { id: "lease-phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { systemImage, profile: "pixel_8" } };
  let controller: Awaited<ReturnType<typeof startController>> | undefined, port = 0, runner: HostRunner | undefined;
  const start = async () => {
    controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: "8a4d2f3e-5a7b-4c1d-9e2f-0123456789ab", listen: { host: "127.0.0.1", port } });
    port = controller.address.port;
  };
  await start();
  const url = `http://127.0.0.1:${port}`;
  const config: HostConfig = { url, stateDir: join(root, "r"), enrollmentToken: enrollment, name: "android-tunnel-host", provider: "android", storage: join(root, "d"),
    androidSDK: paths.sdk, templates: [image], capacity: { cpu: 2 * capacity, memoryMiB: 2048 * capacity, diskGiB: 8 * capacity }, pollIntervalSeconds: fixture.poll ?? .25, concurrency: 4,
    leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1, leaseImages: [{ id: image.id, revision: "1", arch, runtime: "android" }], ...(fixture.tunnels ? { leaseTunnelProtocol: 1 } : {}),
    ...(fixture.warmPool ? { leaseWarmPool: { maxDevices: 1, maxAgeSeconds: 600 } } : {}) };
  const launch = async () => {
    runner = new HostRunner(config, { providerFactory: (settings, state) => new AndroidProvider({ ...settings, transport: transport(paths, counters, devices, fixture) }, state) });
    await runner.start();
  };
  await launch();
  t.after(async () => {
    await runner?.close().catch(() => {}); await controller?.close().catch(() => {});
    for (const state of devices.values()) for (const entry of state.forward.values()) { for (const socket of entry.sockets) socket.destroy(); entry.server.close(); }
    for (const e of readdirSync(paths.registry).map(n => JSON.parse(readFileSync(join(paths.registry, n), "utf8")) as Emulator)) for (const pid of [e.grandchild, e.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    if (existsSync(join(root, "d"))) for (const file of readdirSync(join(root, "d")).map(id => join(root, "d", id, "lease-supervisor.json")).filter(existsSync)) {
      try { process.kill(Number(JSON.parse(readFileSync(file, "utf8")).supervisorPid), "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const api = async (method: string, route: string, body?: unknown, token = admin) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { url, admin, enrollment, root, image, registry: paths.registry, counters, devices, fixture, api,
    runner: () => runner!,
    async restartRunner() { await runner!.close(); await launch(); },
    async stopController() { await controller!.close(); },
    async startController() { await start(); },
    async application(tunnelsPerLease) {
      const created = await api("POST", "/v1/consumers", { id: randomUUID(), name: "agents", templates: [{ id: image.id, revision: "1", arch }],
        limits: { resources: { cpu: 16, memoryMiB: 65536, diskGiB: 256 }, activeLeases: 8, defaultTTLSeconds: 60, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 120, ...(tunnelsPerLease === undefined ? {} : { tunnelsPerLease }) } });
      assert.equal(created.status, 200, JSON.stringify(created.body)); return created.body.credential as string;
    },
    storage: (machineId: string) => join(root, "d", machineId),
    async reserved() { const hosts = (await api("GET", "/v1/hosts")).body.hosts as RecordValue[]; return hosts[0]!.reserved as RecordValue; },
    calls(machineId, prefix) { let n = 0; for (const [key, count] of counters) if (key.startsWith(`cvm-${machineId}:${prefix}`)) n += count; return n; },
    device: machineId => devices.get(`cvm-${machineId}`),
  };
}
interface Lease { id: string; key: string; machineId: string }
async function acquire(h: Harness, app: string, ttlSeconds: number): Promise<Lease> {
  const id = randomUUID();
  assert.equal((await h.api("POST", "/v1/requests", { id, kind: "lease", intent: { templateId: h.image.id, templateRevision: "1", arch, ttlSeconds } }, app)).status, 201);
  await until(async () => (await h.api("GET", `/v1/requests/${id}`, undefined, app)).body.state === "admitted", "admission");
  let lease: any;
  await until(async () => { lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; return lease.state === "ready"; }, "a booted, checked emulator", 30000 + 8000 * (h.fixture.poll ?? 0));
  const key = (await h.api("POST", `/v1/leases/${id}/credential`, {}, app)).body.credential as string;
  return { id, key, machineId: lease.members[0].machineId };
}
async function cleaned(h: Harness, app: string, lease: string): Promise<void> {
  await until(async () => (await h.api("GET", `/v1/leases/${lease}`, undefined, app)).body.cleanup?.state === "complete", "positive cleanup", 30000);
}
function client(h: Harness, lease: { id: string; key: string }): LeaseClient {
  return new LeaseClient({ baseUrl: h.url, leaseId: lease.id, leaseKey: lease.key, allowLoopbackHttp: true, timeoutMs: 20000 });
}

/** Ordered bytes of one connection, with bounded waits. */
class Reader {
  private chunks: Buffer[] = []; private size = 0; private waiters: (() => void)[] = [];
  ended = false; closed = false;
  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => { this.chunks.push(chunk); this.size += chunk.length; this.wake(); });
    socket.on("end", () => { this.ended = true; this.wake(); }); socket.on("close", () => { this.closed = true; this.wake(); }); socket.on("error", () => {});
  }
  private wake(): void { for (const waiter of this.waiters.splice(0)) waiter(); }
  private wait(): Promise<void> { return new Promise(resolve => { const timer = setTimeout(resolve, 100); this.waiters.push(() => { clearTimeout(timer); resolve(); }); }); }
  async take(count: number, ms = 30000): Promise<Buffer> {
    const deadline = Date.now() + ms;
    while (this.size < count) {
      if (this.ended || this.closed) throw new Error(`connection ended after ${this.size} of ${count} bytes`);
      if (Date.now() > deadline) throw new Error(`timed out after ${this.size} of ${count} bytes`);
      await this.wait();
    }
    const all = Buffer.concat(this.chunks); this.chunks = [all.subarray(count)]; this.size -= count;
    return all.subarray(0, count);
  }
  async line(ms = 30000): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
      const all = Buffer.concat(this.chunks), end = all.indexOf(10);
      if (end >= 0) return (await this.take(end + 1)).subarray(0, end).toString();
      if (this.ended || this.closed) throw new Error("connection ended before a full line");
      if (Date.now() > deadline) throw new Error("timed out waiting for a line");
      await this.wait();
    }
  }
  /** Resolves once the peer finished or the connection closed. */
  async finished(ms = 10000): Promise<void> { const deadline = Date.now() + ms; while (!this.ended && !this.closed) { if (Date.now() > deadline) throw new Error("connection is still open"); await this.wait(); } }
}
function pattern(size: number, seed = 7): Buffer {
  const data = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >>> 8) * seed + seed) & 255;
  return data;
}
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
/** A small line protocol standing in for a dev server (or an app on the device): `ECHO word`,
 * `GET n` (n pattern bytes back) and `PUT n` followed by n bytes (their SHA-256 back). */
function serve(socket: Socket): void {
  socket.on("error", () => {});
  let buffer: Buffer = Buffer.alloc(0), upload: { remaining: number; hash: Hash } | undefined;
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (upload) {
        const part = buffer.subarray(0, upload.remaining);
        upload.hash.update(part); upload.remaining -= part.length; buffer = buffer.subarray(part.length);
        if (upload.remaining) return;
        socket.write(upload.hash.digest("hex") + "\n"); upload = undefined; continue;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      const [verb, value] = buffer.subarray(0, end).toString().split(" "); buffer = buffer.subarray(end + 1);
      if (verb === "ECHO") socket.write(`echo ${value}\n`);
      else if (verb === "GET") socket.write(pattern(Number(value)));
      else if (verb === "PUT") upload = { remaining: Number(value), hash: createHash("sha256") };
    }
  });
  socket.on("end", () => socket.end());
}
async function listening(handler: (socket: Socket) => void): Promise<{ server: Server; port: number; sockets: Set<Socket>; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); handler(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, port: (server.address() as AddressInfo).port, sockets, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => { server.close(() => resolve()); }); } };
}
/** An app on the device connecting to `localhost:<port>`: the adb daemon opens one stream to the
 * host endpoint the mapping names. Without a mapping the device port has no listener. */
function deviceConnect(h: Harness, machineId: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const spec = h.device(machineId)?.reverse.get(port);
    if (!spec) { reject(new Error("connection refused: nothing listens on that device port")); return; }
    const socket = spec.startsWith("localfilesystem:") ? connect({ path: spec.slice("localfilesystem:".length), allowHalfOpen: true }) : connect({ host: "127.0.0.1", port: Number(spec.replace(/^tcp:/, "")), allowHalfOpen: true });
    socket.once("error", reject); socket.once("connect", () => { socket.removeListener("error", reject); socket.on("error", () => {}); resolve(socket); });
  });
}
/** An app on the device listening on `port`. */
async function deviceListen(t: TestContext, h: Harness, machineId: string, port: number, handler: (socket: Socket) => void): Promise<void> {
  const service = await listening(handler);
  t.after(() => service.close());
  h.device(machineId)!.services.set(port, service.port);
}
/** Sizes are several flow-control windows, so credit must return in both directions. The fixture
 * runs the controller, runner and SDK on one event loop, which the runner's reconcile loop keeps
 * busy with synchronous file and helper calls; throughput here says nothing about a native host. */
async function exchange(socket: Socket, kilobytes = 768): Promise<void> {
  const reader = new Reader(socket), size = kilobytes * 1024;
  socket.write("ECHO hello\n"); assert.equal(await reader.line(), "echo hello");
  // Bytes toward the connecting side.
  socket.write(`GET ${size}\n`); assert.equal(sha(await reader.take(size)), sha(pattern(size)));
  // Bytes toward the listening side.
  const upload = pattern(size, 11);
  socket.write(`PUT ${size}\n`); socket.write(upload); assert.equal(await reader.line(), sha(upload));
  // Half-close travels end to end in both directions.
  socket.end(); await reader.finished();
}
/** The lease holder's side of a tunnel driven by hand, without the SDK's relay and its own limits. */
async function rawPeer(h: Harness, lease: Lease, tunnel: { id: string; generation: string }) {
  const connection = await SessionConnection.connect(client(h, lease).tunnels.transport, `/v1/leases/${lease.id}/tunnels/${tunnel.id}/${tunnel.generation}`, tunnel.id);
  const messages: (Record<string, unknown> | Buffer)[] = [], state = { ended: false };
  void (async () => { try { for (;;) { const next = await connection.receive(1000); if (next !== null) messages.push(next); } } catch { state.ended = true; } })();
  return { connection, state, controls: (type: string) => messages.filter((message): message is Record<string, unknown> => !Buffer.isBuffer(message) && message.type === type) };
}
const mappingsOf = (h: Harness, machineId: string) => ({ reverse: [...(h.device(machineId)?.reverse ?? [])], forward: [...(h.device(machineId)?.forward ?? [])].map(([local, entry]) => [local, entry.port]) });
async function refused(work: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(work, (error: any) => { assert.equal(error.code, code, error.message); if (status) assert.equal(error.status, status); return true; });
}

test("CI runs the integration tests: the native lease helper is built there", () => {
  // Locally the integration tests below are skipped without the helper. In CI that would hide
  // them, so a missing helper is a failure there.
  if (process.env.CI) assert.ok(unix && existsSync(helper), "build canaveral-mobile-native and run script/prepare_native.mjs before npm test");
});

test("tunnels are an explicit, validated declaration on the host, the offer and the application policy", () => {
  const image = { id: "phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage, profile: "pixel_8" } };
  const base = { name: "h", provider: "android", capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, templates: [image], storage: "/var/lib/canaveral/android" };
  const lease = { leaseProtocol: 1, leaseImages: [{ id: "phone", revision: "1", arch, runtime: "android" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" };
  if (unix) {
    // Off by default; on only with the explicit declaration.
    assert.equal(hostOffer({ ...base, ...lease }).leaseTunnelProtocol, undefined);
    assert.equal(hostOffer({ ...base, ...lease, leaseTunnelProtocol: 1 }).leaseTunnelProtocol, 1);
    assert.throws(() => hostOffer({ ...base, ...lease, leaseTunnelProtocol: 2 }), /Unsupported lease tunnel protocol/);
    // The host-side socket lives in the lease's storage, so the storage path must fit a socket address.
    assert.throws(() => hostOffer({ ...base, ...lease, leaseTunnelProtocol: 1, storage: "/" + "s".repeat(70) }), /storage path of at most/);
    assert.throws(() => hostOffer({ ...base, ...lease, leaseTunnelProtocol: 1, storage: "/var/lib/canaveral devices" }), /without spaces/);
  }
  assert.throws(() => hostOffer({ ...base, leaseTunnelProtocol: 1 }), /require lease execution/);
  // An account-owned emulator is not fenced from the host's adb server, through which a tunnelled
  // device port is reachable. A host that declares tunnels offers Android for leases only.
  const plain = { ...image, id: "plain-phone" };
  if (unix) {
    assert.throws(() => hostOffer({ ...base, ...lease, leaseTunnelProtocol: 1, templates: [image, plain] }), /only leased Android templates/);
    assert.equal(hostOffer({ ...base, ...lease, templates: [image, plain] }).leaseTunnelProtocol, undefined, "without the declaration the same host is unchanged");
  }
  // The packaged example is a valid lease host that declares tunnels.
  const examples = [new URL("../../../examples/", import.meta.url), new URL("../../../../examples/", import.meta.url)].map(url => fileURLToPath(url)).find(directory => existsSync(join(directory, "host-android-leases.json")))!;
  const example = loadHost(JSON.parse(readFileSync(join(examples, "host-android-leases.json"), "utf8")), examples);
  if (unix) assert.deepEqual([hostOffer(example).leaseProtocol, hostOffer(example).leaseTunnelProtocol, (hostOffer(example).leaseImages as unknown[]).length], [1, 1, 1]);
  assert.equal(hostOffer(loadHost(JSON.parse(readFileSync(join(examples, "host-android.json"), "utf8")), examples)).leaseTunnelProtocol, undefined);
  assert.equal(tunnelStorageProblem("/var/lib/canaveral/android"), undefined);
  assert.match(tunnelStorageProblem("relative")!, /absolute/);
  // The controller keeps the declaration only on top of lease execution.
  const offer = { name: "h", provider: "android", capacity: base.capacity, templates: [image], leaseProtocol: 1, leaseImages: lease.leaseImages };
  assert.equal(validateOffer({ ...offer, leaseTunnelProtocol: 1 }).leaseTunnelProtocol, 1);
  assert.equal(validateOffer(offer).leaseTunnelProtocol, undefined);
  assert.throws(() => validateOffer({ name: "h", provider: "android", capacity: base.capacity, templates: [image], leaseTunnelProtocol: 1 }), /require lease execution/);
  assert.throws(() => validateOffer({ ...offer, leaseTunnelProtocol: true }), /require lease execution/);
  assert.throws(() => validateOffer({ ...offer, leaseTunnelProtocol: 1, templates: [image, plain] }), /only leased Android templates/);
  assert.equal(validateOffer({ ...offer, templates: [image, plain] }).templates.length, 2);
  // Request shape: a reverse tunnel listens on an unprivileged device port; adb's own port is never mapped.
  assert.deepEqual(tunnelIntent("reverse", 8081, undefined), { direction: "reverse", devicePort: 8081, idleSeconds: 600 });
  for (const [direction, port, idle] of [["reverse", 80, undefined], ["reverse", 5555, undefined], ["forward", 5555, undefined], ["forward", 0, undefined], ["forward", 65536, undefined], ["socks", 8081, undefined], ["reverse", 8081, 9], ["reverse", 8081, 3601], ["reverse", 8081.5, undefined]] as const)
    assert.equal(tunnelIntent(direction, port, idle), undefined, `${direction} ${port} ${idle}`);
  assert.deepEqual(parseMappings("host-7 tcp:8081 localfilesystem:/a/b.sock\n\nemulator-5554 localfilesystem:/a/c.sock tcp:9000\n"), [{ owner: "host-7", local: "tcp:8081", remote: "localfilesystem:/a/b.sock" }, { owner: "emulator-5554", local: "localfilesystem:/a/c.sock", remote: "tcp:9000" }]);
  assert.equal(parseMappings("unexpected output with more fields than three"), undefined);
  // `forward --list` is server-wide: only this device's lines are judged, and another device's line is
  // skipped before it is parsed, whatever it contains.
  assert.deepEqual(parseMappings("emulator-5556 tcp:1 tcp:2\nemulator-9999 a line with far too many fields to be a mapping\nemulator-5554 localfilesystem:/a/c.sock tcp:9000\n", "emulator-5554"),
    [{ owner: "emulator-5554", local: "localfilesystem:/a/c.sock", remote: "tcp:9000" }]);
  assert.equal(parseMappings("emulator-5554 an unreadable line of this very device\n", "emulator-5554"), undefined);
});

test("the relay carries stream numbers only: no control names a destination, and each side may send only its own controls", () => {
  const text = (value: unknown) => Buffer.from(JSON.stringify(value));
  for (const side of ["host", "consumer"] as const) {
    for (const control of [{ type: "open", stream: 1 }, { type: "accept", stream: 1 }, { type: "end", stream: 1 }, { type: "credit", stream: 1, bytes: TUNNEL_WINDOW_BYTES }, { type: "reset", stream: 1, reason: "idle" }]) validateRelayMessage("tunnel", side, text(control), false);
    validateRelayMessage("tunnel", side, Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("x")]), true);
    for (const control of [{ type: "open", stream: 1, host: "127.0.0.1", port: 22 }, { type: "open", stream: 1, target: "tcp:5037" }, { type: "connect", stream: 1, host: "10.0.2.2" }, { type: "open", stream: 0 }, { type: "credit", stream: 1, bytes: TUNNEL_WINDOW_BYTES + 1 },
      { type: "reset", stream: 1, reason: "other" }, { type: "ready" }, { type: "socks" }]) assert.throws(() => validateRelayMessage("tunnel", side, text(control), false), `${side} ${JSON.stringify(control)}`);
    assert.throws(() => validateRelayMessage("tunnel", side, Buffer.from([0, 0, 0, 1]), true), "a data frame needs payload");
  }
  validateRelayMessage("tunnel", "host", text({ type: "tunnel", direction: "reverse", devicePort: 8081 }), false);
  validateRelayMessage("tunnel", "host", text({ type: "error", code: "tunnel_mapping_failed", message: "m", outcome: "unknown" }), false);
  assert.throws(() => validateRelayMessage("tunnel", "consumer", text({ type: "tunnel", direction: "reverse", devicePort: 8081 }), false));
  assert.throws(() => validateRelayMessage("tunnel", "consumer", text({ type: "error", code: "tunnel_mapping_failed", message: "m", outcome: "unknown" }), false));
});

/** Two relays joined in memory, as the broker joins the runner and the SDK. */
function joined(): [TunnelChannel, TunnelChannel] {
  const make = () => ({ queue: [] as (Record<string, unknown> | Uint8Array)[], wake: undefined as (() => void) | undefined, closed: false });
  const a = make(), b = make();
  const side = (mine: ReturnType<typeof make>, other: ReturnType<typeof make>): TunnelChannel => {
    const push = async (message: Record<string, unknown> | Uint8Array) => { if (mine.closed || other.closed) throw new Error("closed"); other.queue.push(message); other.wake?.(); };
    return { sendControl: value => push(structuredClone(value)), sendBytes: value => push(Buffer.from(value)),
      async receive() {
        if (!mine.queue.length && !mine.closed) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); mine.wake = () => { clearTimeout(timer); mine.wake = undefined; resolve(); }; });
        const next = mine.queue.shift();
        if (next === undefined && mine.closed) throw new Error("closed");
        return next ?? null;
      },
      close() { mine.closed = true; other.closed = true; mine.wake?.(); other.wake?.(); } };
  };
  return [side(a, b), side(b, a)];
}
test("the relay ends the tunnel on a flow-control or stream violation and refuses connections beyond its limit", { timeout: 30000 }, async t => {
  const target = await listening(serve); t.after(() => target.close());
  const dial = () => new Promise<Socket>((resolve, reject) => { const socket = connect({ host: "127.0.0.1", port: target.port, allowHalfOpen: true }); socket.once("error", reject); socket.once("connect", () => resolve(socket)); });
  // A well-behaved pair with two connections allowed.
  const [left, right] = joined();
  const listener = new TunnelRelay(left, { role: "listen", idleSeconds: 60, connections: 2 }), connector = new TunnelRelay(right, { role: "connect", idleSeconds: 60, connections: 2, connect: dial });
  const ends = [listener.run(), connector.run()];
  const front = await listening(socket => listener.accept(socket)); t.after(() => front.close());
  const open = () => new Promise<Socket>(resolve => { const socket = connect({ host: "127.0.0.1", port: front.port, allowHalfOpen: true }, () => resolve(socket)); socket.on("error", () => {}); });
  const first = await open(), second = await open(), firstReader = new Reader(first);
  first.write("ECHO one\n"); assert.equal(await firstReader.line(), "echo one");
  const third = new Reader(await open()); await third.finished();
  assert.deepEqual([listener.stats.active, listener.stats.refused, connector.stats.active], [2, 1, 2]);
  second.destroy(); await until(() => listener.stats.active === 1 && connector.stats.active === 1, "the closed connection's slot");
  const fourth = await open(), fourthReader = new Reader(fourth);
  fourth.write("ECHO four\n"); assert.equal(await fourthReader.line(), "echo four");
  listener.close();
  assert.deepEqual((await Promise.all(ends)).map(end => end.reason), ["closed", "disconnected"]);
  await firstReader.finished();
  // A peer that sends more than its window, opens out of order or uses an unknown stream ends the tunnel.
  for (const violate of [
    async (channel: TunnelChannel) => { await channel.sendControl({ type: "open", stream: 1 }); await sleep(200); for (let sent = 0; sent <= TUNNEL_WINDOW_BYTES; sent += 65532) await channel.sendBytes(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.alloc(65532)])); },
    async (channel: TunnelChannel) => { await channel.sendControl({ type: "open", stream: 5 }); await channel.sendControl({ type: "open", stream: 5 }); },
    async (channel: TunnelChannel) => { await channel.sendControl({ type: "end", stream: 9 }); },
    async (channel: TunnelChannel) => { await channel.sendControl({ type: "open", stream: 1, host: "127.0.0.1", port: 22 }); },
    async (channel: TunnelChannel) => { await channel.sendBytes(Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("early")])); },
  ]) {
    const [rogue, honest] = joined(), relay = new TunnelRelay(honest, { role: "connect", idleSeconds: 60, connect: dial }), ended = relay.run();
    await violate(rogue).catch(() => {});
    assert.equal((await ended).reason, "protocol");
  }
  // The connecting side never opens a stream, and the listening side never accepts one from its peer.
  const [rogue, honest] = joined(), relay = new TunnelRelay(honest, { role: "listen", idleSeconds: 60 }), ended = relay.run();
  await rogue.sendControl({ type: "open", stream: 1 });
  assert.equal((await ended).reason, "protocol");
});

test("the relay's own checks end a tunnel within their bounds and say why; opens are rate-bounded and a flood ends the tunnel", { timeout: 60000 }, async t => {
  const target = await listening(serve); t.after(() => target.close());
  let dials = 0;
  const dial = () => new Promise<Socket>((resolve, reject) => { dials++; const socket = connect({ host: "127.0.0.1", port: target.port, allowHalfOpen: true }); socket.once("error", reject); socket.once("connect", () => resolve(socket)); });
  // Authorization is polled every 250 ms: a lapse ends the tunnel within that interval.
  {
    const [left] = joined(); let allowed = true;
    const relay = new TunnelRelay(left, { role: "listen", idleSeconds: 60, authorized: () => allowed }), ended = relay.run();
    await sleep(300);
    const lapsed = performance.now(); allowed = false;
    assert.deepEqual(await ended, { reason: "unauthorized" });
    assert.ok(performance.now() - lapsed < 400, `ended ${performance.now() - lapsed} ms after authorization lapsed`);
  }
  // The device check runs once a second. Its rejection ends the tunnel, and the owner reports the
  // cause before the channel closes, so the other side and the controller can learn it.
  {
    const [left] = joined(), order: string[] = []; let lost = false;
    const close = left.close.bind(left); left.close = () => { order.push("channel closed"); close(); };
    const relay = new TunnelRelay(left, { role: "listen", idleSeconds: 60, alive: async () => { if (lost) throw Object.assign(new Error("gone"), { code: "tunnel_mapping_lost" }); },
      ending: async end => { await sleep(20); order.push(`reported ${end.code}`); } }), ended = relay.run();
    await sleep(100);
    const since = performance.now(); lost = true;
    assert.deepEqual(await ended, { reason: "unauthorized", code: "tunnel_mapping_lost" });
    assert.deepEqual(order, ["reported tunnel_mapping_lost", "channel closed"]);
    assert.ok(performance.now() - since < 1400, `ended ${performance.now() - since} ms after the mapping was lost`);
  }
  // Connecting side: opens beyond the rate are answered without dialing, so opening and resetting
  // in a loop costs no connection.
  {
    const [rogue, honest] = joined(); dials = 0;
    const relay = new TunnelRelay(honest, { role: "connect", idleSeconds: 60, openBurst: 3, opensPerSecond: 1, connect: dial }), ended = relay.run();
    for (let stream = 1; stream <= 10; stream++) { await rogue.sendControl({ type: "open", stream }); await rogue.sendControl({ type: "reset", stream, reason: "closed" }); }
    const refusedStreams: unknown[] = [];
    for (let i = 0; i < 200 && refusedStreams.length < 7; i++) { const message = await rogue.receive(); if (message && !(message instanceof Uint8Array) && message.type === "reset" && message.reason === "limit") refusedStreams.push(message.stream); }
    assert.deepEqual(refusedStreams, [4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual([dials, relay.stats.opened, relay.stats.refused], [3, 3, 7]);
    relay.close(); await ended;
  }
  // Listening side: connections beyond the rate are closed without opening a stream, and a client
  // that keeps connecting faster than the tolerated rate ends the tunnel instead of costing work forever.
  {
    const [left] = joined(), reported: TunnelEnd[] = [];
    const relay = new TunnelRelay(left, { role: "listen", idleSeconds: 60, openBurst: 2, opensPerSecond: 1, attemptBurst: 12, attemptsPerSecond: 2, ending: async end => { reported.push(end); } }), ended = relay.run();
    const front = await listening(socket => relay.accept(socket)); t.after(() => front.close());
    for (let i = 0; i < 40 && !relay.ended; i++) { const socket = connect({ host: "127.0.0.1", port: front.port }); socket.on("error", () => {}); await sleep(10); }
    assert.deepEqual(await ended, { reason: "flood" });
    assert.deepEqual(reported, [{ reason: "flood" }]);
    assert.ok(relay.stats.opened <= 3 && relay.stats.refused >= 10, JSON.stringify(relay.stats));
  }
  assert.throws(() => new TunnelRelay(joined()[0], { role: "listen", idleSeconds: 60, openBurst: TUNNEL_OPEN_BURST + 1 }), /Invalid tunnel relay options/);
});

/** A real broker for the tunnel family with a stand-in control client, so each test decides what
 * the controller answers and can count how often it is asked. */
async function brokerFixture(t: TestContext, direction: "reverse" | "forward") {
  const id = randomUUID(), generation = randomUUID(), token = randomBytes(32).toString("base64url");
  const state = { authorized: true, busy: false, checks: 0, disconnected: 0 };
  const broker = createSessionUpgradeHandler({ request: async (command: { type: string }) => {
    if (command.type === "tunnels.attach") return { id, generation, capability: "tunnel", direction };
    if (command.type === "tunnels.disconnect") { state.disconnected++; return { disconnected: true }; }
    state.checks++;
    if (state.busy) throw new ServiceError("Controller service is busy.", 429, { retryable: false });
    return { authorized: state.authorized };
  } } as Parameters<typeof createSessionUpgradeHandler>[0], { tunnel: true });
  const server = createHttpServer(); server.on("upgrade", (request, socket, head) => { void broker.handle(request, socket, head); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const consumer = await PeerConnection.connect(origin, `/v1/leases/${randomUUID()}/tunnels/${id}/${generation}`, token), host = await PeerConnection.connect(origin, `/v1/hosts/${randomUUID()}/tunnels/${id}/${generation}`, token);
  t.after(async () => { consumer.close(); host.close(); broker.close(); await new Promise<void>(resolve => { server.close(() => resolve()); }); });
  for (const peer of [consumer, host]) assert.deepEqual(await peer.receive(5), { type: "ready", sessionId: id, generation, capability: "tunnel" });
  return { state, consumer, host };
}

test("the broker relays a stream open only from the side of a tunnel that listens", { timeout: 30000 }, async t => {
  // Reverse: the device side (the runner) listens. Forward: the lease holder does.
  for (const [direction, listening] of [["reverse", "host"], ["forward", "consumer"]] as const) {
    const f = await brokerFixture(t, direction), listener = f[listening], other = listening === "host" ? f.consumer : f.host;
    await listener.sendControl({ type: "open", stream: 1 });
    assert.deepEqual(await other.receive(5), { type: "open", stream: 1 });
    await other.sendControl({ type: "accept", stream: 1 });
    assert.deepEqual(await listener.receive(5), { type: "accept", stream: 1 });
    // The other side tries to start a stream itself: on a reverse tunnel that would be the holder
    // reaching into the device, on a forward tunnel the device initiating toward the holder.
    await other.sendControl({ type: "open", stream: 2 });
    // The pair ends and the open is never delivered. Were it relayed, this read would return it.
    await assert.rejects(listener.receive(5), (error: unknown) => error instanceof ServiceError, `${direction}: the open must not reach the listening side`);
    assert.ok(f.state.disconnected >= 1);
  }
});

test("the broker checks a tunnel's authority on an interval, waits out a busy controller, and bounds what passes between checks and after authority ends", { timeout: 60000 }, async t => {
  const f = await brokerFixture(t, "reverse");
  const frame = (bytes: number) => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.alloc(bytes)]);
  // Hundreds of messages cost a handful of authority checks, not one each.
  let started = performance.now(), asked = f.state.checks, received = 0;
  const messages = 400, reading = (async () => { while (received < messages) if (await f.consumer.receive(10) instanceof Uint8Array) received++; })();
  for (let i = 0; i < messages; i++) await f.host.sendBytes(frame(512));
  await reading;
  let elapsed = performance.now() - started;
  assert.ok(f.state.checks - asked <= Math.ceil(elapsed / 200) + 2, `${f.state.checks - asked} checks for ${messages} messages in ${elapsed} ms`);
  // Between two checks one direction relays at most its byte budget; more waits for the next check.
  const large = frame(65532), total = 3 * TUNNEL_RELAY_BYTES;
  started = performance.now(); let bytes = 0;
  const draining = (async () => { while (bytes < total) { const message = await f.consumer.receive(10); if (message instanceof Uint8Array) bytes += message.byteLength; } })();
  for (let sent = 0; sent < total; sent += large.length) await f.host.sendBytes(large);
  await draining;
  elapsed = performance.now() - started;
  assert.ok(elapsed >= 2 * TUNNEL_AUTHORITY_MS - 100, `three budgets of data passed in ${elapsed} ms`);
  // A busy controller is backpressure: nothing is relayed without a fresh check, and nothing ends.
  f.state.busy = true;
  await sleep(TUNNEL_AUTHORITY_MS + 150);
  await f.host.sendControl({ type: "open", stream: 7 });
  assert.equal(await f.consumer.receive(1), null, "nothing is relayed while the controller cannot confirm the tunnel's authority");
  f.state.busy = false;
  assert.deepEqual(await f.consumer.receive(5), { type: "open", stream: 7 });
  assert.equal(f.state.disconnected, 0, "a busy controller did not end the pair");
  // When the controller says the authority ended, both peers are closed within one interval, and
  // no more than one interval's budget was relayed after the controller's state changed.
  let after = 0, flipped = 0, closed = 0;
  const sink = (async () => { try { for (;;) { const message = await f.consumer.receive(10); if (flipped && message instanceof Uint8Array) after += message.byteLength; } } catch { closed = performance.now(); } })();
  const source = (async () => { try { for (;;) await f.host.sendBytes(large); } catch { /* the pair ended */ } })();
  await sleep(600);
  flipped = performance.now(); f.state.authorized = false;
  await Promise.all([sink, source]);
  assert.ok(closed - flipped < TUNNEL_AUTHORITY_MS + 300, `the pair closed ${closed - flipped} ms after its authority ended`);
  assert.ok(after <= TUNNEL_RELAY_BYTES + large.length, `${after} bytes passed after the controller's state changed`);
  await assert.rejects(f.host.receive(1));
});

/** The controller module on a temporary database with an injected clock: no runner, no adb. */
function controllerFixture(t: TestContext, tunnelsPerLease = 2) {
  const directory = mkdtempSync(join(tmpdir(), "lease-tunnels-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = () => randomBytes(32).toString("base64url"), clock = { now: 1_800_000_000 };
  const store = new SqliteStore(join(directory, "state.sqlite"), () => clock.now), options = { controllerId: randomUUID(), adminToken: key() };
  const machines = new MachineStore(store, options);
  store.transaction(db => initializeLeases(db));
  const applications = new ConsumerIdentities(store), tunnels = new LeaseTunnels(store, machines);
  const image = { id: "lease-phone", revision: "1", arch: "arm64", os: "android", mode: "device", device: { systemImage: "system-images;android-35;google_apis_playstore;arm64-v8a", profile: "pixel_8" }, minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  const offer = { name: "host", provider: "android", capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 64 }, leaseProtocol: 1, leaseTunnelProtocol: 1, templates: [image], leaseImages: [{ id: image.id, revision: image.revision, arch: image.arch, runtime: "android" }] };
  const application = applications.create({ id: randomUUID(), name: "tunnel fixture", templates: [], limits: { activeLeases: 10, resources: { cpu: 10, memoryMiB: 32000, diskGiB: 100 }, tunnelsPerLease } });
  const addHost = (declared = offer) => { const host = { id: randomUUID(), token: key() }; store.transaction(db => { db.prepare("INSERT INTO hosts VALUES (?,?,?,?,1)").run(host.id, legacyDigest(host.token), JSON.stringify(declared), clock.now); }); return host; };
  const addLease = (host: { id: string }) => {
    const lease = { id: randomUUID(), token: key(), machine: randomUUID() };
    store.transaction(db => {
      db.prepare("INSERT INTO machines (id,request,host,template,desired,observed,detail,updated,preparation_state,prepared_at,owner,access_ready) VALUES (?,?,?,?,'running','running','',?,'ready',?,NULL,1)")
        .run(lease.machine, JSON.stringify({ id: lease.machine, resources: image.minimum }), host.id, JSON.stringify(image), clock.now, clock.now);
      db.prepare("INSERT INTO leases VALUES (?,?,?,'ready',1,?,?,?,?,'notRequested')").run(lease.id, application.id, "{}", clock.now, clock.now + 100_000, clock.now + 60, legacyDigest(lease.token));
      db.prepare("INSERT INTO lease_members VALUES (?,'primary',?)").run(lease.id, lease.machine);
    });
    return lease;
  };
  const call = (method: string, path: string, token: string, body: Record<string, unknown> = {}) => tunnels.handle({ method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), token, body,
    principal: () => { throw new Error("lease routes never resolve an account principal"); } }) as { status?: number; body: any };
  const open = (lease: { id: string; token: string }, devicePort: number, direction = "reverse") => call("POST", `/v1/leases/${lease.id}/tunnels`, lease.token, { id: randomUUID(), member: "primary", direction, devicePort });
  const attach = (tunnel: { id: string; generation: string }, side: "host" | "consumer", ownerId: string, token: string) => tunnels.command({ type: "tunnels.attach", sessionId: tunnel.id, generation: tunnel.generation, side, ownerId, token });
  const refused = (work: () => unknown, status: number, code?: string) => assert.throws(work, (error: unknown) => error instanceof ServiceError && error.status === status && (code === undefined || error.code === code), `expected ${status} ${code ?? ""}`);
  const touch = () => store.transaction(db => { db.prepare("UPDATE hosts SET seen=?").run(clock.now); });
  return { store, clock, tunnels, application, addHost, addLease, call, open, attach, refused, touch };
}

test("the tunnel allowance counts open tunnels; an unproven removal keeps only its port; identities are bounded per hour, not for good", { timeout: 60000 }, t => {
  const f = controllerFixture(t), host = f.addHost(), lease = f.addLease(host);
  const close = (tunnel: { id: string }) => f.call("POST", `/v1/leases/${lease.id}/tunnels/${tunnel.id}/close`, lease.token).body;
  // Ends a tunnel after its runner attached and without a removal receipt: an unproven removal.
  const residue = (devicePort: number) => { const tunnel = f.open(lease, devicePort).body; f.attach(tunnel, "host", host.id, host.token); return close(tunnel); };
  const a = f.open(lease, 8081); assert.equal(a.status, 201);
  const b = f.open(lease, 8082).body;
  f.refused(() => f.open(lease, 8083), 429, "tunnel_limit");
  // A tunnel the runner never attached leaves nothing behind: closing it frees everything at once.
  assert.deepEqual([close(b).state, close(b).mappingRemoved], ["closed", true]);
  // One the runner attached keeps its device port until the removal is proven, but no place in the allowance.
  f.attach(a.body, "host", host.id, host.token);
  assert.deepEqual([close(a.body).state, close(a.body).mappingRemoved], ["closed", false]);
  f.refused(() => f.open(lease, 8081), 409, "tunnel_port_busy");
  const c = f.open(lease, 8083).body, d = f.open(lease, 8084).body;
  f.refused(() => f.open(lease, 8085), 429, "tunnel_limit");
  close(c); close(d);
  // Unproven removals have their own bound, so a device that never confirms cannot be used to pile them up.
  for (let port = 8100; port < 8100 + TUNNEL_RESIDUE_PER_LEASE - 1; port++) assert.equal(residue(port).mappingRemoved, false);
  f.refused(() => f.open(lease, 8200), 429, "tunnel_residue_limit");
  // The runner's receipt releases one, and the lease can open tunnels again, on that port too.
  const proven = f.call("POST", `/v1/hosts/${host.id}/tunnels/${a.body.id}/finish`, host.token, { generation: a.body.generation, mappingRemoved: true }).body;
  assert.deepEqual([proven.state, proven.mappingRemoved], ["closed", true]);
  assert.equal(f.open(lease, 8081).status, 201);
  // Another lease is not affected by this one's residue or allowance.
  const neighbour = f.addLease(host);
  assert.equal(f.open(neighbour, 8081).status, 201);
  // Identities: 256 in any hour. Past that the lease waits; it is not stranded for good.
  const busy = f.addLease(host);
  for (let i = 0; i < TUNNEL_IDENTITIES_PER_HOUR; i++) { const tunnel = f.open(busy, 9000 + (i % 2)).body; f.call("POST", `/v1/leases/${busy.id}/tunnels/${tunnel.id}/close`, busy.token); }
  f.refused(() => f.open(busy, 9000), 429, "tunnel_identity_limit");
  assert.equal(f.call("GET", `/v1/leases/${busy.id}/tunnels`, busy.token).body.tunnels.length, 256);
  f.clock.now += 3601; f.touch();
  assert.equal(f.open(busy, 9000).status, 201);
});

test("only the tunnel's own host attaches and reports, only its lease's current key attaches as holder, and the interval check takes no write lock", { timeout: 30000 }, t => {
  const f = controllerFixture(t), host = f.addHost(), other = f.addHost(), lease = f.addLease(host), neighbour = f.addLease(other);
  const tunnel = f.open(lease, 8081).body, finish = (hostId: string, token: string, body: Record<string, unknown>) => f.call("POST", `/v1/hosts/${hostId}/tunnels/${tunnel.id}/finish`, token, body);
  // Another enrolled host with a valid credential of its own, a runner without this lease, gets nowhere.
  f.refused(() => f.attach(tunnel, "host", other.id, other.token), 403);
  f.refused(() => f.attach(tunnel, "host", host.id, other.token), 401);
  f.refused(() => f.attach(tunnel, "host", host.id, lease.token), 401);
  f.refused(() => f.attach(tunnel, "host", other.id, lease.token), 403);
  f.refused(() => finish(other.id, other.token, { generation: tunnel.generation, mappingRemoved: true }), 403);
  f.refused(() => finish(host.id, other.token, { generation: tunnel.generation, mappingRemoved: true }), 401);
  f.refused(() => finish(host.id, lease.token, { generation: tunnel.generation, mappingRemoved: true }), 401);
  // The tunnel's own host cannot report before it attached, nor for another generation.
  f.refused(() => finish(host.id, host.token, { generation: tunnel.generation, mappingRemoved: true }), 403);
  // Nor can another lease's key, the application key or a host key attach as the holder.
  f.refused(() => f.attach(tunnel, "consumer", lease.id, neighbour.token), 403);
  f.refused(() => f.attach(tunnel, "consumer", neighbour.id, neighbour.token), 403);
  f.refused(() => f.attach(tunnel, "consumer", lease.id, f.application.credential), 403);
  f.refused(() => f.attach(tunnel, "consumer", lease.id, host.token), 403);
  assert.equal(f.call("GET", `/v1/leases/${lease.id}/tunnels/${tunnel.id}`, lease.token).body.state, "pending", "refused callers changed nothing");
  assert.deepEqual(f.attach(tunnel, "host", host.id, host.token), { id: tunnel.id, generation: tunnel.generation, capability: "tunnel", direction: "reverse" });
  f.attach(tunnel, "consumer", lease.id, lease.token);
  f.refused(() => f.attach(tunnel, "host", host.id, host.token), 409);
  f.refused(() => finish(host.id, host.token, { generation: randomUUID(), mappingRemoved: true }), 403);
  // The broker's interval check: asked many times, it runs no transaction hook and takes no write lock.
  let transactions = 0;
  f.store.addTransactionHook(() => { transactions++; });
  const authorized = () => f.tunnels.command({ type: "tunnels.authorized", sessionId: tunnel.id, generation: tunnel.generation, ready: true }) as { authorized: boolean };
  for (let i = 0; i < 100; i++) assert.equal(authorized().authorized, true);
  assert.equal(transactions, 0);
  f.refused(() => f.tunnels.command({ type: "tunnels.authorized", sessionId: tunnel.id, generation: randomUUID() }), 403);
  // What the runner found is recorded once and never revives the tunnel. A receipt must say something.
  for (const body of [{ generation: tunnel.generation }, { generation: tunnel.generation, mappingRemoved: false }, { generation: tunnel.generation, reason: "because" }, { generation: tunnel.generation, mappingRemoved: true, extra: 1 }]) f.refused(() => finish(host.id, host.token, body), 400);
  const lost = finish(host.id, host.token, { generation: tunnel.generation, reason: "mapping_lost" }).body;
  assert.deepEqual([lost.state, lost.endReason, lost.mappingRemoved], ["disconnected", "mapping_lost", false]);
  assert.equal(authorized().authorized, false);
  const settled = finish(host.id, host.token, { generation: tunnel.generation, mappingRemoved: true, reason: "open_rate" }).body;
  assert.deepEqual([settled.state, settled.endReason, settled.mappingRemoved], ["disconnected", "mapping_lost", true]);
  // Expiry is decided by the check itself, from the lease's own deadline, and written exactly once.
  const second = f.open(lease, 8082).body;
  f.attach(second, "host", host.id, host.token); f.attach(second, "consumer", lease.id, lease.token);
  const check = () => (f.tunnels.command({ type: "tunnels.authorized", sessionId: second.id, generation: second.generation, ready: true }) as { authorized: boolean }).authorized;
  assert.equal(check(), true);
  f.store.transaction(db => { db.prepare("UPDATE leases SET expires=? WHERE id=?").run(f.clock.now + 5, lease.id); });
  f.clock.now += 6; f.touch(); transactions = 0;
  assert.deepEqual([check(), check(), transactions], [false, false, 1]);
  assert.equal(f.call("GET", `/v1/leases/${lease.id}/tunnels/${second.id}`, lease.token).body.state, "expired");
  // A rotated key ends the old key's tunnel.
  const third = f.open(neighbour, 8081).body;
  f.attach(third, "host", other.id, other.token); f.attach(third, "consumer", neighbour.id, neighbour.token);
  const rotated = randomBytes(32).toString("base64url");
  f.store.transaction(db => { db.prepare("UPDATE leases SET credential=? WHERE id=?").run(legacyDigest(rotated), neighbour.id); });
  assert.deepEqual(f.tunnels.command({ type: "tunnels.authorized", sessionId: third.id, generation: third.generation, ready: true }), { authorized: false });
  assert.equal(f.call("GET", `/v1/leases/${neighbour.id}/tunnels/${third.id}`, rotated).body.state, "revoked");
});

test("an uncertain open is reported as unknown and never retried by the SDK", { timeout: 20000 }, async t => {
  let requests = 0;
  const server = createHttpServer((request, response) => { requests++; request.resume(); request.on("end", () => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const tunnels = new LeaseTunnelClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, leaseId: randomUUID(), leaseKey: randomBytes(32).toString("base64url"), allowLoopbackHttp: true, timeoutMs: 5000 });
  const id = randomUUID();
  await assert.rejects(tunnels.open({ id, member: "primary", direction: "reverse", devicePort: 8081, target: { port: 8081 } }), (error: any) => error.outcome === "unknown" && error.requestId === id);
  assert.equal(requests, 1, "exactly one request was sent");
  // Requests that cannot be valid never leave the machine.
  for (const request of [{ id, member: "primary", direction: "reverse", devicePort: 8081 }, { id, member: "primary", direction: "reverse", devicePort: 80, target: { port: 1 } }, { id, member: "primary", direction: "forward", devicePort: 9000, target: { port: 1 } },
    { id, member: "primary", direction: "reverse", devicePort: 8081, target: { host: "*", port: 1 } }, { id, member: "primary", direction: "forward", devicePort: 9000, listen: { host: "localhost" } }, { id, member: "primary", direction: "socks", devicePort: 1080, target: { port: 1 } }])
    await assert.rejects(tunnels.open(request as any), (error: any) => error.name === "ConsumerConfigurationError");
  assert.equal(requests, 1);
});

test("the packaged contracts describe the tunnel routes and controls", () => {
  const api = consumerApiSchema() as any, session = sessionProtocolSchema() as any;
  for (const [path, methods] of [["/v1/leases/{leaseId}/tunnels", ["post", "get"]], ["/v1/leases/{leaseId}/tunnels/{tunnelId}", ["get"]], ["/v1/leases/{leaseId}/tunnels/{tunnelId}/close", ["post"]], ["/v1/leases/{leaseId}/tunnels/{tunnelId}/{generation}", ["get"]]] as const)
    for (const method of methods) assert.deepEqual(api.paths[path]?.[method]?.security, [{ LeaseBearer: [] }], `${method} ${path}`);
  for (const name of ["CreateTunnel", "Tunnel", "TunnelList"]) assert.ok(api.components.schemas[name], name);
  assert.equal(api.components.schemas.Limits.properties.tunnelsPerLease.maximum, 8);
  // Every local reference in the document resolves.
  const references: string[] = [];
  JSON.stringify(api, (key, value) => { if (key === "$ref") references.push(value); return value; });
  for (const reference of references) assert.ok(reference.split("/").slice(1).reduce((node: any, part: string) => node?.[part], api), reference);
  assert.deepEqual(session["x-canaveral-streams"].tunnel.binary, { consumer: "tunnel-stream", host: "tunnel-stream", maxMessageBytes: 65536 });
  for (const name of ["TunnelMapped", "TunnelStream", "TunnelCredit", "TunnelReset", "tunnelConsumer", "tunnelHost"]) assert.ok(session.$defs[name], name);
  assert.ok(session.$defs.WorkerError.properties.code.enum.includes("tunnel_mapping_failed"));
  assert.equal(session.$defs.TunnelStream.additionalProperties, false, "stream controls carry no destination");
});

test("a lease key tunnels in both directions through the controller; other credentials are refused; limits hold; no mapping survives a close", { skip, timeout: 240000 }, async t => {
  const h = await harness(t, 2, { tunnels: true, warmPool: true }), app = await h.application(2), plain = await h.application();
  const host = h.runner().identity!.id;
  const pool = `/v1/hosts/${host}/warm-pool`;
  const configured = await h.api("POST", pool, { targets: [{ templateId: h.image.id, templateRevision: "1", arch, count: 1 }] });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  let warmMachine: string | undefined;
  await until(async () => {
    warmMachine = (await h.api("GET", pool)).body.devices.find((device: any) => device.state === "ready")?.machineId;
    return !!warmMachine;
  }, "a warm device that passed the mapping audit", 40000);
  assert.deepEqual(mappingsOf(h, warmMachine!), { reverse: [], forward: [] });
  const warmAudits = h.calls(warmMachine!, "reverse --list");
  assert.ok(warmAudits > 0);
  const a = await acquire(h, app, 300);
  assert.equal(a.machineId, warmMachine);
  assert.ok(h.calls(a.machineId, "reverse --list") > warmAudits, "adoption checks the mappings again");
  assert.equal((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.members[0].source, "warm");
  const b = await acquire(h, plain, 300);
  assert.equal((await h.api("POST", pool, { targets: [] })).status, 200);
  const lease = client(h, a), name = `cvm-${a.machineId}`;
  // Readiness audited the device's mappings, and a lease without a tunnel has none.
  assert.ok(h.calls(a.machineId, "reverse --list") > 0 && h.calls(a.machineId, "forward --list") > 0, "readiness listed the device's mappings");
  assert.deepEqual(mappingsOf(h, a.machineId), { reverse: [], forward: [] });
  await assert.rejects(deviceConnect(h, a.machineId, 8081), /connection refused/);
  assert.deepEqual(await lease.tunnels.list(), []);
  // The holder's dev server, reachable from the device only through the tunnel.
  const metro = await listening(serve); t.after(() => metro.close());
  const first = randomUUID();
  const reverse = await lease.tunnels.open({ id: first, member: "primary", direction: "reverse", devicePort: 8081, target: { port: metro.port } });
  assert.deepEqual([reverse.direction, reverse.devicePort, reverse.local], ["reverse", 8081, { host: "127.0.0.1", port: metro.port }]);
  // One mapping: the device port to a Unix socket inside the lease's own private storage.
  const mapped = mappingsOf(h, a.machineId);
  assert.equal(mapped.reverse.length, 1); assert.deepEqual(mapped.forward, []);
  const [devicePort, spec] = mapped.reverse[0]!, socketPath = spec.replace(/^localfilesystem:/, "");
  assert.equal(devicePort, 8081); assert.match(spec, /^localfilesystem:\//);
  assert.equal(dirname(dirname(socketPath)), h.storage(a.machineId), "the endpoint is inside the lease's storage directory");
  assert.ok(statSync(socketPath).isSocket()); assert.equal(statSync(dirname(socketPath)).mode & 0o077, 0); assert.equal(statSync(h.storage(a.machineId)).mode & 0o077, 0);
  assert.ok(!spec.includes("tcp:"), "no loopback TCP listener is involved on the device host");
  // Bytes both ways, three flow-control windows each, with end-to-end half-close.
  await exchange(await deviceConnect(h, a.machineId, 8081));
  // Several connections at once are independent.
  await Promise.all(Array.from({ length: 4 }, async () => exchange(await deviceConnect(h, a.machineId, 8081), 96)));
  assert.equal(reverse.stats.opened, 5); await until(() => reverse.stats.active === 0, "closed connections");
  // The receipt names the device port and direction, never the holder's target.
  const view = await lease.tunnels.inspect(first);
  assert.deepEqual([view.state, view.direction, view.devicePort, view.member, view.leaseId, view.mappingRemoved, view.idleSeconds], ["ready", "reverse", 8081, "primary", a.id, false, 600]);
  assert.ok(!JSON.stringify(view).includes(String(metro.port)));
  // A replayed intent returns the same tunnel and installs nothing again; a changed body conflicts.
  const body = { id: first, member: "primary", direction: "reverse", devicePort: 8081 };
  const replay = await h.api("POST", `/v1/leases/${a.id}/tunnels`, body, a.key);
  assert.deepEqual([replay.status, replay.body.generation, replay.body.state], [200, view.generation, "ready"]);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels`, { ...body, devicePort: 8082 }, a.key)).status, 409);
  assert.equal(h.calls(a.machineId, "reverse --no-rebind"), 1);
  // A tunnel identity is used once: the SDK refuses to attach again and leaves the running tunnel alone.
  await refused(lease.tunnels.open({ id: first, member: "primary", direction: "reverse", devicePort: 8081, target: { port: metro.port } }), 410, "tunnel_ended");
  assert.equal((await lease.tunnels.inspect(first)).state, "ready");
  // The same device port cannot be mapped twice.
  const busy = await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081 }, a.key);
  assert.deepEqual([busy.status, busy.body.code], [409, "tunnel_port_busy"]);
  // Only the lease's current key: not another lease's key, an application key, the operator or the runner.
  const runnerKey = JSON.parse(readFileSync(join(h.root, "r", "identity.json"), "utf8")).credential as string;
  for (const token of [b.key, app, plain, h.admin, runnerKey]) {
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8090 }, token)).status, 401);
    assert.equal((await h.api("GET", `/v1/leases/${a.id}/tunnels`, undefined, token)).status, 401);
    assert.equal((await h.api("GET", `/v1/leases/${a.id}/tunnels/${first}`, undefined, token)).status, 401);
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels/${first}/close`, {}, token)).status, 401);
    // Nor can any of them attach to the tunnel's relay.
    const impostor = new LeaseTunnelClient({ baseUrl: h.url, leaseId: a.id, leaseKey: token, allowLoopbackHttp: true, timeoutMs: 5000 });
    await assert.rejects(impostor.connect({ ...view, state: "pending" }, { target: { port: metro.port } }));
  }
  assert.equal((await h.api("GET", `/v1/leases/${b.id}/tunnels/${first}`, undefined, b.key)).status, 404, "another lease cannot see the tunnel under its own key");
  const hostId = ((await h.api("GET", "/v1/hosts")).body.hosts as RecordValue[])[0]!.id as string;
  assert.equal((await h.api("POST", `/v1/hosts/${hostId}/tunnels/${first}/finish`, { generation: view.generation, mappingRemoved: true }, a.key)).status, 401, "the runner receipt needs the host credential");
  assert.equal((await lease.tunnels.inspect(first)).state, "ready", "refused callers changed nothing");
  // An application whose policy allows no tunnels is refused, on the same host.
  const disabled = await h.api("POST", `/v1/leases/${b.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081 }, b.key);
  assert.deepEqual([disabled.status, disabled.body.code], [403, "tunnels_not_permitted"]);
  assert.deepEqual(mappingsOf(h, b.machineId), { reverse: [], forward: [] });
  // Forward: the holder reaches a port on the device through a loopback listener.
  await deviceListen(t, h, a.machineId, 9000, serve);
  const forward = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "forward", devicePort: 9000 });
  assert.equal(forward.local.host, "127.0.0.1"); assert.ok(forward.local.port > 0);
  const forwarded = mappingsOf(h, a.machineId).forward;
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0]![1], 9000);
  assert.equal(dirname(dirname(String(forwarded[0]![0]).replace(/^localfilesystem:/, ""))), h.storage(a.machineId));
  const dial = (port: number) => new Promise<Socket>((resolve, reject) => { const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true }); socket.once("error", reject); socket.once("connect", () => resolve(socket)); });
  await exchange(await dial(forward.local.port));
  // A forward tunnel creates no listener on the device: adb still holds only the reverse tunnel's
  // mapping. That neither peer can start a stream from the device side of a forward tunnel is
  // asserted where it is enforced, against the broker and the relay (component tests above).
  assert.deepEqual(mappingsOf(h, a.machineId).reverse.map(([port]) => port), [8081]);
  assert.equal(h.calls(a.machineId, "reverse --no-rebind"), 1);
  // The lease holds its limit of two tunnels; a third is refused before anything is installed.
  const over = await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "forward", devicePort: 9001 }, a.key);
  assert.deepEqual([over.status, over.body.code], [429, "tunnel_limit"]);
  assert.equal((await lease.tunnels.list()).filter(tunnel => tunnel.state === "ready").length, 2);
  // Closing removes the mapping, proves it and frees the slot and the device port.
  const stream = new Reader(await deviceConnect(h, a.machineId, 8081));
  assert.deepEqual(await reverse.close(), { reason: "closed", state: "closed" });
  await stream.finished();
  await until(() => mappingsOf(h, a.machineId).reverse.length === 0, "reverse mapping removal");
  await until(async () => (await lease.tunnels.inspect(first)).mappingRemoved === true, "the runner's removal receipt");
  assert.equal(existsSync(socketPath), false);
  await assert.rejects(deviceConnect(h, a.machineId, 8081), /connection refused/);
  assert.deepEqual(await forward.close(), { reason: "closed", state: "closed" });
  await until(() => mappingsOf(h, a.machineId).forward.length === 0, "forward mapping removal");
  await until(async () => (await lease.tunnels.inspect(forward.id)).mappingRemoved === true, "the forward removal receipt");
  await assert.rejects(dial(forward.local.port), "the local listener closed with the tunnel");
  // A device port an app already bound cannot be mapped: a clear error, nothing left behind.
  h.device(a.machineId)!.busy.add(8083);
  const failing = randomUUID();
  await refused(lease.tunnels.open({ id: failing, member: "primary", direction: "reverse", devicePort: 8083, target: { port: metro.port } }), 0, "tunnel_mapping_failed");
  await until(async () => { const ended = await lease.tunnels.inspect(failing); return ended.state !== "ready" && ended.mappingRemoved; }, "the failed tunnel's settlement");
  assert.deepEqual(mappingsOf(h, a.machineId), { reverse: [], forward: [] });
  assert.deepEqual(readdirSync(dirname(socketPath)), [], "no socket is left in the lease's tunnel directory");
  // The CLI holds a tunnel open in the foreground from a private lease-key file.
  const keyFile = join(h.root, "lease.key"); writeFileSync(keyFile, a.key + "\n", { mode: 0o600 });
  const stop = new AbortController(), output: string[] = [], errors: string[] = [];
  const command = main(["--url", h.url, "--token-file", keyFile, "--allow-http", "tunnel", a.id, "reverse", "--device-port", "8081", "--target", `127.0.0.1:${metro.port}`],
    { stdout: text => { output.push(text); }, stderr: text => { errors.push(text); }, signal: stop.signal });
  await until(() => output.length > 0, "the CLI's open line", 30000);
  const opened = JSON.parse(output[0]!);
  assert.deepEqual([opened.state, opened.direction, opened.devicePort, opened.target, opened.leaseId], ["open", "reverse", 8081, `127.0.0.1:${metro.port}`, a.id]);
  assert.match(errors.join(""), /^Tunnel UUID [0-9a-f-]{36}\n$/);
  assert.ok(!output.join("").includes(a.key) && !errors.join("").includes(a.key));
  await exchange(await deviceConnect(h, a.machineId, 8081), 96);
  stop.abort();
  assert.equal(await command, 0);
  assert.equal(JSON.parse(output[1]!).state, "closed");
  await until(() => mappingsOf(h, a.machineId).reverse.length === 0, "the CLI tunnel's mapping removal");
  // Refusals are explained; a mistyped direction never reaches the controller.
  const refusal: string[] = [];
  assert.equal(await main(["--url", h.url, "--token-file", keyFile, "--allow-http", "tunnel", b.id, "reverse", "--device-port", "8081"], { stdout: () => {}, stderr: text => { refusal.push(text); } }), 1);
  assert.match(refusal.join(""), /lease key was refused/);
  refusal.length = 0;
  assert.equal(await main(["--url", h.url, "--token-file", keyFile, "--allow-http", "tunnel", a.id, "sideways", "--device-port", "8081"], { stdout: () => {}, stderr: text => { refusal.push(text); } }), 1);
  assert.match(refusal.join(""), /reverse \(device to this machine\) or forward/);
  // Release: nothing of the tunnels remains and every reservation returns.
  for (const l of [a, b]) assert.equal((await h.api("POST", `/v1/leases/${l.id}/release`, { id: randomUUID() }, l.key)).status, 200);
  await cleaned(h, app, a.id); await cleaned(h, plain, b.id);
  assert.ok((await lease.tunnels.list()).every(tunnel => tunnel.mappingRemoved && !["pending", "attaching", "ready"].includes(tunnel.state)));
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081 }, a.key)).body.code, "lease_ended");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a host that does not declare tunnels refuses them, and the policy limit is validated and normalized", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { tunnels: false }), app = await h.application(2);
  const hosts = (await h.api("GET", "/v1/hosts")).body.hosts as any[];
  assert.equal(JSON.stringify(hosts).includes("leaseTunnelProtocol"), false, "the host never declared tunnels");
  const a = await acquire(h, app, 120), lease = client(h, a);
  const denied = await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081 }, a.key);
  assert.deepEqual([denied.status, denied.body.code], [409, "capability_unsupported"]);
  await refused(lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "forward", devicePort: 9000 }), 409, "capability_unsupported");
  assert.equal(h.calls(a.machineId, "reverse --no-rebind") + h.calls(a.machineId, "forward --no-rebind"), 0);
  // Without the declaration the host behaves exactly as before tunnels existed: readiness never lists
  // or judges adb mappings. (This stand-in refuses those queries on such a host, and the lease became ready.)
  assert.equal(h.calls(a.machineId, "reverse --list") + h.calls(a.machineId, "forward --list"), 0);
  // Even a controller that asked would be refused by the runner's own gate.
  const provider = h.runner().runtimes.get("android") as unknown as AndroidProvider;
  assert.throws(() => provider.openTunnel({ id: a.machineId, lease: { id: a.id } }, h.image, "", { id: randomUUID(), direction: "reverse", devicePort: 8081 }, () => true, () => {}), /does not offer lease tunnels/);
  // Shape and membership are checked before policy.
  for (const body of [{ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 80 }, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081, target: "127.0.0.1:8081" }, { id: randomUUID(), member: "primary", direction: "both", devicePort: 8081 }, { id: randomUUID(), direction: "reverse", devicePort: 8081 }])
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels`, body, a.key)).status, 400, JSON.stringify(body));
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "other", direction: "reverse", devicePort: 8081 }, a.key)).status, 404);
  // Existing policies get no tunnels; the limit is bounded and returned normalized.
  await h.application();
  const limits = ((await h.api("GET", "/v1/consumers")).body.consumers as any[]).map(consumer => consumer.limits.tunnelsPerLease);
  assert.deepEqual(limits, [2, 0]);
  assert.equal((await h.api("GET", "/v1/environments/templates", undefined, app)).body.limits.tunnelsPerLease, 2);
  for (const value of [9, -1, 1.5, "2", null]) {
    const created = await h.api("POST", "/v1/consumers", { id: randomUUID(), name: "agents", templates: [], limits: { resources: { cpu: 1, memoryMiB: 1024, diskGiB: 1 }, activeLeases: 1, tunnelsPerLease: value } });
    assert.equal(created.status, 400, String(value));
  }
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
});

test("connections are bounded, a stalled endpoint applies backpressure, idle connections end, and a mapping no tunnel created fences the lease", { skip, timeout: 240000 }, async t => {
  const h = await harness(t), app = await h.application(4);
  // `adb forward --list` covers every device of the adb server. A line of another device that is
  // not even a mapping must not affect this lease, here or anywhere below.
  h.fixture.forwardNoise = "emulator-9998 this line belongs to another device and is not three fields\nemulator-9999 tcp:7000 tcp:7001";
  const a = await acquire(h, app, 300), lease = client(h, a);
  const echo = await listening(serve); t.after(() => echo.close());
  const tunnel = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081, target: { port: echo.port } });
  // Concurrent connections up to the limit; the next one is closed at once and its slot never opens a stream.
  const held: { socket: Socket; reader: Reader }[] = [];
  for (let i = 0; i < TUNNEL_CONNECTIONS; i++) {
    const socket = await deviceConnect(h, a.machineId, 8081), reader = new Reader(socket);
    socket.write(`ECHO c${i}\n`); held.push({ socket, reader });
  }
  for (const [i, connection] of held.entries()) assert.equal(await connection.reader.line(), `echo c${i}`);
  assert.equal(tunnel.stats.active, TUNNEL_CONNECTIONS);
  const extra = new Reader(await deviceConnect(h, a.machineId, 8081));
  extra.socket.write("ECHO over\n"); await extra.finished();
  assert.deepEqual([tunnel.stats.active, tunnel.stats.opened, echo.sockets.size], [TUNNEL_CONNECTIONS, TUNNEL_CONNECTIONS, TUNNEL_CONNECTIONS]);
  // Releasing one slot admits another connection.
  held[0]!.socket.end(); await held[0]!.reader.finished();
  await until(() => tunnel.stats.active === TUNNEL_CONNECTIONS - 1, "a released connection slot");
  const again = new Reader(await deviceConnect(h, a.machineId, 8081));
  again.socket.write("ECHO again\n"); assert.equal(await again.line(), "echo again");
  for (const connection of [...held.slice(1), again]) connection.socket.destroy();
  await until(() => tunnel.stats.active === 0 && echo.sockets.size === 0, "all connections closed");
  await tunnel.close();

  // Backpressure: the holder's endpoint stops reading; the device's writer stalls instead of the relay buffering.
  const total = 8 * 1024 * 1024, payload = pattern(65536, 3), digest = createHash("sha256");
  let received = 0, resume: (() => void) | undefined;
  const sink = await listening(socket => { socket.on("error", () => {}); socket.pause(); resume = () => { socket.on("data", (chunk: Buffer) => { digest.update(chunk); received += chunk.length; }); socket.resume(); }; });
  t.after(() => sink.close());
  const slow = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8082, target: { port: sink.port } });
  const writer = await deviceConnect(h, a.machineId, 8082), expected = createHash("sha256");
  let sent = 0;
  const pouring = (async () => {
    while (sent < total) {
      expected.update(payload); sent += payload.length;
      if (!writer.write(payload)) await new Promise<void>(resolve => writer.once("drain", () => resolve()));
    }
  })();
  // The writer stops making progress while the endpoint is stalled.
  let last = -1;
  await until(async () => { const before = sent; await sleep(1500); const stalled = before === sent && sent > 0; last = sent; return stalled; }, "a stalled writer", 60000);
  assert.ok(last < total, `the writer stalled after ${last} of ${total} bytes`);
  assert.equal(received, 0);
  // The runner holds at most one window and its socket buffers for this connection, however much
  // the device wants to send; the rest waits in the device's own writer.
  const crossed = slow.stats.bytesFromPeer;
  assert.ok(crossed <= last && last - crossed <= 4 * 1024 * 1024, `${last - crossed} bytes were accepted from the device but not relayed`);
  await sleep(1000); assert.equal(slow.stats.bytesFromPeer, crossed, "nothing more crosses the relay while the endpoint is stalled");
  assert.equal(sent, last, "and the device's writer stays stalled");
  // Once it reads again, everything arrives intact.
  resume!(); await pouring; writer.end();
  await until(() => received === total, "the complete transfer", 120000);
  assert.equal(digest.digest("hex"), expected.digest("hex"));
  await slow.close();

  // Idle: a connection that carries nothing for the tunnel's idle time is reset.
  const quiet = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8083, target: { port: echo.port }, idleSeconds: 10 });
  const idle = new Reader(await deviceConnect(h, a.machineId, 8083)), started = Date.now();
  idle.socket.write("ECHO once\n"); assert.equal(await idle.line(), "echo once");
  await idle.finished(20000);
  assert.ok(Date.now() - started >= 9000 && Date.now() - started < 16000, `reset after ${Date.now() - started} ms`);
  await until(() => quiet.stats.active === 0, "the idle connection's slot");
  // The tunnel itself stays open for new connections.
  const fresh = new Reader(await deviceConnect(h, a.machineId, 8083));
  fresh.socket.write("ECHO fresh\n"); assert.equal(await fresh.line(), "echo fresh"); fresh.socket.destroy();

  // A mapping can vanish while its tunnel is open, for example when the adb server or the device
  // transport restarts. The runner notices, ends that tunnel and records why; the lease and its
  // other tunnels are unaffected.
  const vanishing = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8085, target: { port: echo.port } });
  const through = new Reader(await deviceConnect(h, a.machineId, 8085));
  through.socket.write("ECHO there\n"); assert.equal(await through.line(), "echo there");
  let dropped = Date.now();
  h.device(a.machineId)!.reverse.delete(8085);
  let gone = await vanishing.closed;
  assert.deepEqual([gone.endReason, gone.state], ["mapping_lost", "disconnected"]);
  assert.ok(Date.now() - dropped < 6000, `the lost reverse mapping was noticed after ${Date.now() - dropped} ms`);
  await through.finished();
  await deviceListen(t, h, a.machineId, 9002, serve);
  const forwarded = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "forward", devicePort: 9002 });
  dropped = Date.now();
  for (const [local, entry] of [...h.device(a.machineId)!.forward]) if (entry.port === 9002) { for (const socket of entry.sockets) socket.destroy(); entry.server.close(); h.device(a.machineId)!.forward.delete(local); }
  gone = await forwarded.closed;
  assert.deepEqual([gone.endReason, gone.state], ["mapping_lost", "disconnected"]);
  assert.ok(Date.now() - dropped < 6000, `the lost forward mapping was noticed after ${Date.now() - dropped} ms`);
  for (const ended of [vanishing, forwarded]) await until(async () => (await lease.tunnels.inspect(ended.id)).mappingRemoved === true, "the lost tunnel's settlement");
  assert.deepEqual([(await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state, (await lease.tunnels.inspect(quiet.id)).state], ["ready", "ready"]);

  // The runner's own limits as the connecting side of a forward tunnel, reached by a holder peer
  // that ignores the SDK's limits. An app on the device accepts and holds every connection.
  const holding = await listening(socket => { socket.on("error", () => {}); socket.on("end", () => socket.end()); socket.resume(); }); t.after(() => holding.close());
  h.device(a.machineId)!.services.set(9003, holding.port);
  const manual = (await lease.tunnels.create({ id: randomUUID(), member: "primary", direction: "forward", devicePort: 9003 })).tunnel;
  const raw = await rawPeer(h, a, manual);
  await until(() => raw.controls("tunnel").length === 1, "the installed forward mapping", 20000);
  const dialed = () => [...h.device(a.machineId)!.forward.values()].find(entry => entry.port === 9003)!.accepted;
  for (let stream = 1; stream <= TUNNEL_CONNECTIONS + 1; stream++) await raw.connection.sendControl({ type: "open", stream });
  await until(() => raw.controls("accept").length === TUNNEL_CONNECTIONS && raw.controls("reset").length === 1, "the runner's connection limit as connector");
  assert.deepEqual(raw.controls("reset")[0], { type: "reset", stream: TUNNEL_CONNECTIONS + 1, reason: "limit" });
  // A relay accept confirms the connecting socket. The fixture's server callbacks run separately.
  await until(() => holding.sockets.size >= TUNNEL_CONNECTIONS, "the device app accepted the allowed connections");
  assert.equal(dialed(), TUNNEL_CONNECTIONS, "the stream beyond the limit was never dialed");
  // Opening and resetting in a loop: the controller lets only so many opens through per interval,
  // and the runner answers the ones beyond its open rate without dialing the device.
  for (let stream = 1; stream <= TUNNEL_CONNECTIONS; stream++) await raw.connection.sendControl({ type: "reset", stream, reason: "closed" });
  await until(() => holding.sockets.size === 0, "the reset connections");
  const flood = 200, first = TUNNEL_CONNECTIONS + 2, before = dialed(), flooding = Date.now();
  for (let stream = first; stream < first + flood; stream++) { await raw.connection.sendControl({ type: "open", stream }); await raw.connection.sendControl({ type: "reset", stream, reason: "closed" }); }
  const limited = () => raw.controls("reset").filter(control => control.reason === "limit" && Number(control.stream) >= first).length;
  await until(() => limited() + dialed() - before === flood, "a refusal or a dial for every open", 30000);
  const seconds = (Date.now() - flooding) / 1000, admitted = dialed() - before;
  assert.ok(admitted <= TUNNEL_OPEN_BURST + TUNNEL_OPENS_PER_SECOND * (seconds + 3) && admitted < flood, `${admitted} of ${flood} opens were dialed in ${seconds} s`);
  assert.ok(seconds * 1000 >= (flood / TUNNEL_RELAY_OPENS - 2) * TUNNEL_AUTHORITY_MS, `the controller relayed ${flood} opens in ${seconds} s`);
  assert.deepEqual([raw.state.ended, (await lease.tunnels.inspect(manual.id)).state], [false, "ready"], "a bounded burst does not end the tunnel");
  await lease.tunnels.close(manual.id); await until(() => raw.state.ended, "the closed tunnel's relay");

  // A reverse mapping that no tunnel created (another tool ran `adb reverse` against the leased device)
  // would give the guest a path to the host. The audit fences the lease; the open tunnel ends with it.
  const canary = await listening(socket => socket.destroy()); t.after(() => canary.close());
  // Cleanup removes the lease's storage soon after the fence, so the fence is observed as it happens.
  let fenced = false;
  const watching = setInterval(() => { try { fenced ||= JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-authorization.json"), "utf8")).fenced === true; } catch { /* not readable at this instant */ } }, 10);
  t.after(() => clearInterval(watching));
  h.device(a.machineId)!.reverse.set(8099, `tcp:${canary.port}`);
  const ended = await quiet.closed;
  assert.notEqual(ended.reason, "closed");
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state === "failed", "the fenced lease", 20000);
  await until(() => fenced, "the runner's fence of the native authorization", 5000);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8084 }, a.key)).body.code, "lease_ended");
  await cleaned(h, app, a.id);
  assert.ok((await lease.tunnels.list()).every(item => item.mappingRemoved));
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a tunnel ends with its lease: key rotation and release within a second, supervisor loss within two, expiry with the lease", { skip, timeout: 240000 }, async t => {
  const h = await harness(t, 2), app = await h.application(2);
  const echo = await listening(serve); t.after(() => echo.close());
  const open = async (l: Lease, key = l.key): Promise<{ tunnel: LeaseTunnel; reader: Reader }> => {
    const tunnel = await client(h, { id: l.id, key }).tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081, target: { port: echo.port } });
    const reader = new Reader(await deviceConnect(h, l.machineId, 8081));
    reader.socket.write("ECHO up\n"); assert.equal(await reader.line(), "echo up");
    return { tunnel, reader };
  };
  /** Times the device's connection from the moment the cause took effect until it is closed, and
   * asserts the documented bound: one second for an end the controller can see (a 250 ms check
   * interval), two for one only the device shows (a one-second check). These are measured on a
   * single event loop shared by the controller, the runner and the reconcile loop of every
   * emulator; what makes each mechanism fire is asserted separately, in the component tests and
   * in the runner's-own-evidence test below. */
  const ends = async (active: { tunnel: LeaseTunnel; reader: Reader }, cause: () => Promise<unknown> | unknown, bound: number, label: string): Promise<void> => {
    await cause();
    const started = Date.now();
    await active.reader.finished(15000);
    const elapsed = Date.now() - started;
    t.diagnostic(`${label}: the device's connection closed after ${elapsed} ms`);
    const end = await Promise.race([active.tunnel.closed, sleep(15000).then(() => undefined)]);
    assert.ok(end, "the tunnel ended"); assert.notEqual(end.reason, "closed");
    assert.ok(elapsed < bound, `${label}: the device's connection stayed open for ${elapsed} ms`);
  };
  const [rotated, released] = await Promise.all([acquire(h, app, 300), acquire(h, app, 300)]);

  // Key rotation: the old key's tunnel ends at once; the lease and device stay, so the runner removes and proves the mapping.
  const first = await open(rotated);
  let key = "";
  await ends(first, async () => { key = (await h.api("POST", `/v1/leases/${rotated.id}/credential`, {}, app)).body.credential; }, 1000, "key rotation");
  const holder = client(h, { id: rotated.id, key });
  await until(async () => { const saved = await holder.tunnels.inspect(first.tunnel.id); return saved.state === "revoked" && saved.mappingRemoved; }, "the rotated tunnel's removal receipt");
  assert.deepEqual(mappingsOf(h, rotated.machineId), { reverse: [], forward: [] });
  assert.equal((await h.api("GET", `/v1/leases/${rotated.id}/tunnels/${first.tunnel.id}`, undefined, rotated.key)).status, 401);
  await assert.rejects(client(h, rotated).tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081, target: { port: echo.port } }), (error: any) => error.status === 401);
  // The new key opens a new tunnel on the same device port.
  const second = await open(rotated, key);

  // Release: the tunnel ends with the lease, and the lease's cleanup settles its mapping.
  const releasing = await open(released);
  await ends(releasing, () => h.api("POST", `/v1/leases/${released.id}/release`, { id: randomUUID() }, released.key), 1000, "release");
  assert.equal((await client(h, released).tunnels.inspect(releasing.tunnel.id)).state, "revoked");
  await cleaned(h, app, released.id);
  await until(async () => (await client(h, released).tunnels.inspect(releasing.tunnel.id)).mappingRemoved === true, "settlement by lease cleanup");
  assert.equal(existsSync(h.storage(released.machineId)), false);

  // Supervisor loss: nothing enforces the deadline any more, so the tunnel ends with device access.
  const orphaned = await acquire(h, app, 300);
  const lost = await open(orphaned), group = JSON.parse(readFileSync(join(h.storage(orphaned.machineId), "lease-supervisor.json"), "utf8")) as { childPid: number; supervisorPid: number };
  await ends(lost, () => process.kill(group.supervisorPid, "SIGKILL"), 2000, "supervisor loss");
  await until(async () => (await h.api("GET", `/v1/leases/${orphaned.id}`, undefined, app)).body.state === "failed", "the failed lease", 15000);
  await until(async () => (await h.api("GET", `/v1/leases/${orphaned.id}`, undefined, app)).body.cleanup.state === "blocked", "blocked cleanup");
  // The emulator survives unsupervised, so its stop is unproven and the tunnel's mapping is not claimed removed.
  // What remains on the device points at a closed, removed socket: it reaches nothing.
  assert.ok(alive(group.childPid));
  const residue = await client(h, orphaned).tunnels.inspect(lost.tunnel.id);
  assert.deepEqual([residue.mappingRemoved, ["revoked", "disconnected"].includes(residue.state)], [false, true]);
  await assert.rejects(deviceConnect(h, orphaned.machineId, 8081));
  assert.equal(readdirSync(join(h.storage(orphaned.machineId), "t")).length, 0, "the host-side endpoint is gone");
  // Cleanup waits for the emulator's stop proof, never for the tunnel: the documented recovery completes it.
  process.kill(-group.childPid, "SIGKILL");
  await cleaned(h, app, orphaned.id);
  await until(async () => (await client(h, orphaned).tunnels.inspect(lost.tunnel.id)).mappingRemoved === true, "settlement after recovery");

  // Expiry: the tunnel ends when the lease does, long before its own idle time or any other deadline.
  const expiring = await acquire(h, app, 14), expiry = await open(expiring), opened = Date.now();
  const end = await Promise.race([expiry.tunnel.closed, sleep(40000).then(() => undefined)]);
  assert.ok(end && end.reason !== "closed", "the tunnel ended at expiry");
  assert.ok(Date.now() - opened < 25000, `the tunnel outlived its lease by ${Date.now() - opened} ms`);
  await expiry.reader.finished(5000);
  // The runner fences slightly before the controller's expiry; either way the lease is over within moments.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${expiring.id}`, undefined, app)).body.state), "terminal lease", 10000);
  assert.ok(["expired", "revoked", "disconnected"].includes((await client(h, expiring).tunnels.inspect(expiry.tunnel.id)).state));
  await cleaned(h, app, expiring.id);
  await until(async () => (await client(h, expiring).tunnels.inspect(expiry.tunnel.id)).mappingRemoved === true, "settlement after expiry");

  // The surviving lease's tunnel was never disturbed by the others.
  second.reader.socket.write("ECHO still\n"); assert.equal(await second.reader.line(), "echo still");
  assert.equal((await h.api("POST", `/v1/leases/${rotated.id}/release`, { id: randomUUID() }, key)).status, 200);
  await cleaned(h, app, rotated.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a replayed open after a lost reply attaches the one tunnel; runner and controller restarts end tunnels without reinstalling them", { skip, timeout: 240000 }, async t => {
  const h = await harness(t), app = await h.application(4);
  const a = await acquire(h, app, 300), lease = client(h, a);
  const echo = await listening(serve); t.after(() => echo.close());
  const talk = async (port: number, word: string) => { const reader = new Reader(await deviceConnect(h, a.machineId, port)); reader.socket.write(`ECHO ${word}\n`); assert.equal(await reader.line(), `echo ${word}`); return reader; };
  // The create reply is lost: the caller replays the identical request with the same UUID.
  const id = randomUUID(), request = { id, member: "primary", direction: "reverse" as const, devicePort: 8081 };
  const lost = await h.api("POST", `/v1/leases/${a.id}/tunnels`, request, a.key);
  assert.equal(lost.status, 201);
  const tunnel = await lease.tunnels.open({ ...request, target: { port: echo.port } });
  assert.equal(tunnel.tunnel.generation, lost.body.generation, "the replay attached the tunnel the lost reply created");
  await talk(8081, "replayed");
  // Later replays of that UUID never open another tunnel or mapping.
  for (let i = 0; i < 3; i++) assert.deepEqual([(await h.api("POST", `/v1/leases/${a.id}/tunnels`, request, a.key)).status, (await lease.tunnels.create(request)).created], [200, false]);
  await sleep(1500);
  assert.equal(h.calls(a.machineId, "reverse --no-rebind"), 1); assert.equal(mappingsOf(h, a.machineId).reverse.length, 1);
  assert.equal((await lease.tunnels.list()).length, 1);

  // Runner restart: the tunnel ends. Its journal forbids a second install; the mapping left on the
  // device points at a dead socket, is removed by the audit, and the restarted runner reports it.
  const ending = tunnel.closed;
  await h.restartRunner();
  assert.notEqual((await ending).reason, "closed");
  assert.equal((await lease.tunnels.inspect(id)).state, "disconnected");
  await until(() => mappingsOf(h, a.machineId).reverse.length === 0, "removal of the restart residue", 30000);
  await until(async () => (await lease.tunnels.inspect(id)).mappingRemoved === true, "the restarted runner's receipt", 30000);
  assert.equal(h.calls(a.machineId, "reverse --no-rebind"), 1, "the restarted runner never reinstalled the tunnel");
  assert.equal((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state, "ready", "the lease and its device survived the restart");
  // A replay after the tunnel ended returns its tombstone; a new UUID opens a new tunnel.
  assert.deepEqual([(await h.api("POST", `/v1/leases/${a.id}/tunnels`, request, a.key)).body.state, h.calls(a.machineId, "reverse --no-rebind")], ["disconnected", 1]);
  await refused(lease.tunnels.open({ ...request, target: { port: echo.port } }), 410, "tunnel_ended");
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.members[0].ready === true, "a ready device after the restart");
  const next = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081, target: { port: echo.port } });
  await talk(8081, "after-restart");

  // Controller restart: every relay is cut and the tunnel is disconnected; the runner removes its mapping.
  const cut = next.closed;
  await h.stopController(); await h.startController();
  assert.notEqual((await cut).reason, "closed");
  await until(async () => { const saved = await lease.tunnels.inspect(next.id).catch(() => undefined); return saved?.state === "disconnected" && saved.mappingRemoved; }, "the disconnected tunnel's removal receipt", 30000);
  assert.deepEqual(mappingsOf(h, a.machineId), { reverse: [], forward: [] });
  assert.equal(h.calls(a.machineId, "reverse --no-rebind"), 2);

  // A removal the device refuses is not claimed: the tunnel keeps its slot and port until the lease's cleanup settles it.
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.members[0].ready === true, "a ready device after the controller restart");
  h.fixture.removeFails = true;
  const stuck = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8086, target: { port: echo.port } });
  await talk(8086, "stuck");
  await stuck.close();
  await sleep(2500);
  const unproven = await lease.tunnels.inspect(stuck.id);
  assert.deepEqual([unproven.state, unproven.mappingRemoved], ["closed", false]);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/tunnels`, { id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8086 }, a.key)).body.code, "tunnel_port_busy");
  // The leftover mapping names a removed socket: the device reaches nothing through it.
  await assert.rejects(deviceConnect(h, a.machineId, 8086));
  // It does not use up the lease's allowance: another port opens while the removal is unproven.
  const beside = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8087, target: { port: echo.port } });
  await talk(8087, "beside");
  // The runner keeps retrying. Once the device removes it, the runner reports it and the port is free again.
  h.fixture.removeFails = false;
  await until(async () => (await lease.tunnels.inspect(stuck.id)).mappingRemoved === true, "the retried removal's receipt", 30000);
  assert.deepEqual(mappingsOf(h, a.machineId).reverse.map(([port]) => port), [8087]);
  const reopened = await lease.tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8086, target: { port: echo.port } });
  await talk(8086, "reopened");
  // A second unproven removal is settled by the lease's own cleanup instead.
  h.fixture.removeFails = true;
  await reopened.close(); await beside.close();
  await sleep(2500);
  assert.deepEqual((await lease.tunnels.list()).filter(item => !item.mappingRemoved).map(item => item.devicePort).sort(), [8086, 8087]);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  await until(async () => (await lease.tunnels.list()).every(item => item.mappingRemoved), "settlement by lease cleanup");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("the isolation probe still fences a leaky guest on a host that offers tunnels, before any tunnel can exist", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { tunnels: true, guest: "leaky" }), app = await h.application(2);
  const id = randomUUID();
  assert.equal((await h.api("POST", "/v1/requests", { id, kind: "lease", intent: { templateId: h.image.id, templateRevision: "1", arch, ttlSeconds: 60 } }, app)).status, 201);
  let machineId = "";
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; machineId = lease.members?.[0]?.machineId ?? ""; return !!machineId; }, "admitted member");
  // The launch still carries every isolation argument.
  await until(() => existsSync(join(h.storage(machineId), "launch.json")), "the launch record");
  assert.deepEqual(JSON.parse(readFileSync(join(h.storage(machineId), "launch.json"), "utf8")).argv.slice(-LEASE_ISOLATION_ARGUMENTS.length), LEASE_ISOLATION_ARGUMENTS);
  const views: string[] = [];
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; views.push(lease.state); return lease.state === "failed"; }, "failed lease", 30000);
  assert.ok(!views.includes("ready"), "the lease never became ready");
  assert.equal(existsSync(join(h.storage(machineId), "lease-isolation.json")), false);
  assert.ok((await h.api("POST", `/v1/leases/${id}/credential`, {}, app)).status >= 400, "no key is issued for a fenced lease");
  assert.equal(h.calls(machineId, "reverse --no-rebind") + h.calls(machineId, "forward --no-rebind"), 0, "no mapping was ever installed");
  await cleaned(h, app, id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("the runner ends a tunnel on its own evidence before the controller can know, and no other host can attach to or report for a tunnel", { skip, timeout: 240000 }, async t => {
  // Heartbeats five seconds apart, as on a default host: whatever happens within a second or two of
  // a heartbeat was decided by the runner alone.
  const h = await harness(t, 2, { tunnels: true, poll: 5 }), app = await h.application(2);
  const echo = await listening(serve); t.after(() => echo.close());
  const [fenced, orphaned] = await Promise.all([acquire(h, app, 300), acquire(h, app, 300)]);
  const heartbeat = async () => { const last = h.runner().lastContact; await until(() => h.runner().lastContact !== last, "the next heartbeat", 15000); };
  const leaseState = async (lease: Lease) => (await h.api("GET", `/v1/leases/${lease.id}`, undefined, app)).body.state as string;
  // Another enrolled host with a valid credential of its own: a runner without this lease.
  const other = { id: randomUUID(), credential: randomBytes(32).toString("base64url") }, hostId = h.runner().identity!.id;
  assert.equal((await h.api("POST", "/v1/hosts/enroll", { ...other, orchestrator: h.url, offer: { ...h.runner().offer, name: "another-android-host" } }, h.enrollment)).status, 200);
  // A new tunnel waits for its own host's next heartbeat. Until then nobody else can take the host's place.
  await heartbeat();
  const holder = client(h, fenced), pending = (await holder.tunnels.create({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081 })).tunnel;
  for (const [host, credential] of [[other.id, other.credential], [hostId, other.credential], [hostId, fenced.key], [other.id, fenced.key], [hostId, app]] as const) {
    await assert.rejects(PeerConnection.connect(h.url, `/v1/hosts/${host}/tunnels/${pending.id}/${pending.generation}`, credential), `${host === hostId ? "the tunnel's host id" : "another host"} with a foreign credential`);
    assert.ok([401, 403].includes((await h.api("POST", `/v1/hosts/${host}/tunnels/${pending.id}/finish`, { generation: pending.generation, mappingRemoved: true }, credential)).status));
  }
  const untouched = await holder.tunnels.inspect(pending.id);
  assert.deepEqual([untouched.state, untouched.mappingRemoved], ["pending", false]);
  assert.equal(h.calls(fenced.machineId, "reverse --no-rebind"), 0);
  // Its own host attaches at the next heartbeat, and the tunnel works.
  const first = await holder.tunnels.connect(pending, { target: { port: echo.port } });
  const firstReader = new Reader(await deviceConnect(h, fenced.machineId, 8081));
  firstReader.socket.write("ECHO up\n"); assert.equal(await firstReader.line(), "echo up");
  const second = await client(h, orphaned).tunnels.open({ id: randomUUID(), member: "primary", direction: "reverse", devicePort: 8081, target: { port: echo.port } });
  const secondReader = new Reader(await deviceConnect(h, orphaned.machineId, 8081));
  secondReader.socket.write("ECHO up\n"); assert.equal(await secondReader.line(), "echo up");

  // The runner's lease guard fences the lease locally, as it does at its own deadline or without
  // controller contact. The controller hears of it only with the next heartbeat, seconds away.
  await heartbeat();
  let since = Date.now();
  h.runner().guard.records.get(fenced.machineId)!.fenced = true;
  await firstReader.finished(10000);
  let elapsed = Date.now() - since;
  t.diagnostic(`local fence: the device's connection closed after ${elapsed} ms`);
  assert.ok(elapsed < 1000, `the runner's own authority check took ${elapsed} ms`);
  assert.notEqual((await first.closed).reason, "closed");
  assert.equal(await leaseState(fenced), "ready", "the controller had not been told yet");

  // The supervisor dies. The runner's once-a-second device check sees the free lock and ends the tunnel.
  await heartbeat();
  const group = JSON.parse(readFileSync(join(h.storage(orphaned.machineId), "lease-supervisor.json"), "utf8")) as { childPid: number; supervisorPid: number };
  since = Date.now();
  process.kill(group.supervisorPid, "SIGKILL");
  await secondReader.finished(10000);
  elapsed = Date.now() - since;
  t.diagnostic(`supervisor loss: the device's connection closed after ${elapsed} ms`);
  assert.ok(elapsed < 2000, `the runner's own device check took ${elapsed} ms`);
  assert.notEqual((await second.closed).reason, "closed");
  assert.equal(await leaseState(orphaned), "ready", "the controller had not been told yet");
  // Both leases then fail through the ordinary path, and nothing of the tunnels survives cleanup.
  await until(async () => await leaseState(fenced) !== "ready" && await leaseState(orphaned) !== "ready", "the leases' own failure", 30000);
  process.kill(-group.childPid, "SIGKILL");
  await cleaned(h, app, fenced.id); await cleaned(h, app, orphaned.id);
  for (const [lease, tunnel] of [[fenced, first], [orphaned, second]] as const) await until(async () => (await client(h, lease).tunnels.inspect(tunnel.id)).mappingRemoved === true, "settlement by lease cleanup", 30000);
});
