/** Lease port tunnels for a leased Android emulator, carried by the device's own control channel.
 *
 * The leased guest has no network (see LEASE_ISOLATION_ARGUMENTS), so a tunnel never uses the
 * guest's network stack or the host's. `adb reverse` asks the guest's adb daemon to listen on
 * one device port and to open, per connection, one stream to a host-side endpoint; `adb forward`
 * asks the host's adb server to listen on a host-side endpoint and open one stream to a device
 * port. In both cases the host-side endpoint is a Unix domain socket inside the lease's own
 * private storage directory (`<storage>/<machine>/t/<name>.sock`, directory mode 0700), not a
 * loopback TCP port, so the tunnel adds no listener to the host's network.
 *
 * That directory is not the whole access boundary. The host's adb server listens without
 * authentication on 127.0.0.1:5037 and lets any local process, of any user, open a connection to
 * a port of any attached device. Opening a reverse tunnel's device port that way reaches the
 * lease holder's target. A leased guest cannot do it (it has no route to the host's loopback),
 * but an emulator launched without the lease isolation arguments could, which is why a host that
 * declares tunnels runs no account-owned emulator. Every local process on such a host must be
 * trusted with what a tunnel exposes. A runner-private adb server behind a Unix socket would
 * close that path; it is not implemented (docs/mobile-control.md).
 *
 * The device never chooses a destination. A reverse mapping is created by this runner for one
 * device port and one socket path, and is held by the adb daemon of a user build, which an app
 * cannot reconfigure. A guest that subverts its adb daemon could reach host endpoints through
 * adb with or without a tunnel; refusing debuggable images is the control for that, unchanged.
 *
 * Native acceptance is open. Whether a given emulator and platform-tools release honours a
 * `localfilesystem:` endpoint for `adb reverse`, the exact `--list` formats, and behaviour when
 * the device port is already bound are covered by fixtures with a stand-in adb only. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import * as path from "node:path";
import { ServiceError } from "../errors.ts";
import { authorized, integer, privateDirectory, uuid } from "./mobile.ts";
import type { Authorized, RecordValue } from "./mobile.ts";
import type { AndroidProvider } from "./android.ts";
import type { TunnelDirection } from "../tunnel-relay.ts";

export interface TunnelSpec { id: string; direction: TunnelDirection; devicePort: number }
export interface TunnelEndpoint {
  /** Forward tunnels: one connection to the mapped device port. */
  connect(): Promise<Socket>;
  /** Rejects once the lease's device access ended (fence, expiry, supervisor loss, foreign serial). */
  alive(): Promise<void>;
  /** Closes the host-side endpoint and removes the mapping. `mappingRemoved` is positive proof
   * only; device commands run only while `deviceAllowed` still holds. Never throws. */
  close(deviceAllowed: Authorized): Promise<{ mappingRemoved: boolean }>;
}
/** Thrown when a mapping could not be installed. `mappingRemoved` says whether nothing was left behind. */
export class TunnelMappingError extends ServiceError {
  constructor(readonly mappingRemoved: boolean) { super("The device port mapping could not be created.", 409, { code: "tunnel_mapping_failed" }); }
}
/** Rejection of `alive` when an installed mapping is positively gone while its tunnel is open. */
export class TunnelMappingLost extends ServiceError {
  constructor() { super("The device port mapping disappeared.", 410, { code: "tunnel_mapping_lost" }); }
}
interface Live extends TunnelSpec { machineId: string; file: string; serial: string; installedAt?: number; closing?: boolean; lost?: boolean }
interface Snapshot { started: number; at: number; reverse: Mapping[]; forward: Mapping[] }
const SOCKET_DIRECTORY = "t", SOCKET_NAME_BYTES = 10 + ".sock".length, ADB_MS = 10_000;
/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminator. */
function socketPathLimit(): number { return process.platform === "darwin" ? 103 : 107; }
/** A storage root that cannot hold a lease's tunnel socket, or undefined when it can. The path
 * is `<root>/<machine UUID>/t/<10 hex>.sock` and must fit the platform's Unix socket path limit;
 * adb prints mappings as whitespace-separated fields, so the root must not contain whitespace. */
export function tunnelStorageProblem(root: string): string | undefined {
  if (!path.isAbsolute(root) || !/^[\x21-\x7e]+$/.test(root)) return "Lease tunnels need an absolute Android storage path of printable ASCII without spaces.";
  const longest = Buffer.byteLength(root) + 1 + 36 + 1 + SOCKET_DIRECTORY.length + 1 + SOCKET_NAME_BYTES, limit = socketPathLimit();
  if (longest > limit) return `Lease tunnels need an Android storage path of at most ${limit - (longest - Buffer.byteLength(root))} bytes on this platform; tunnel sockets live inside each lease's storage.`;
  return undefined;
}
interface Mapping { owner: string; local: string; remote: string }
/** `adb forward --list` and `adb reverse --list` print `<owner> <local> <remote>` per line.
 * `forward --list` is server-wide. With `serial`, only that device's lines are judged: a line of
 * another device is skipped before it is parsed, so its content cannot affect this lease.
 * Undefined when one of the judged lines is not exactly three fields. */
export function parseMappings(output: string, serial?: string): Mapping[] | undefined {
  const result: Mapping[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (serial !== undefined && parts[0] !== serial) continue;
    if (parts.length !== 3) return undefined;
    result.push({ owner: parts[0]!, local: parts[1]!, remote: parts[2]! });
  }
  return result;
}

export class AndroidTunnels {
  /** Mappings this runner installed, or is installing or removing, by tunnel id. */
  private readonly live = new Map<string, Live>();
  private readonly servers = new Map<string, { server: Server; sockets: Set<Socket> }>();
  private readonly liveness = new Map<string, { at: number; check: Promise<void> }>();
  private readonly audited = new Map<string, { boot: unknown; at: number }>();
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(readonly provider: AndroidProvider) {}

  private file(storage: string, id: string): string {
    const problem = tunnelStorageProblem(path.dirname(storage));
    if (problem) throw new ServiceError(problem, 409, { code: "capability_unsupported" });
    return path.join(storage, SOCKET_DIRECTORY, createHash("sha256").update(uuid(id)).digest("hex").slice(0, 10) + ".sock");
  }
  private match(entry: Mapping, tunnel: Live, serial: string): boolean {
    return tunnel.serial === serial && (tunnel.direction === "reverse"
      ? entry.local === `tcp:${tunnel.devicePort}` && entry.remote === `localfilesystem:${tunnel.file}`
      : entry.owner === serial && entry.local === `localfilesystem:${tunnel.file}` && entry.remote === `tcp:${tunnel.devicePort}`);
  }
  private async list(serial: string, direction: TunnelDirection): Promise<Mapping[]> {
    const entries = parseMappings(await this.provider.adb(serial, [direction, "--list"], { timeoutMs: ADB_MS }), direction === "forward" ? serial : undefined);
    if (!entries) throw new ServiceError("Android port mappings could not be read.", 409, { outcome: "unknown" });
    return entries;
  }
  /** Both mapping lists of one device, shared by the audit and the tunnels' own checks. */
  private async snapshot(machineId: string, serial: string, fresh: boolean): Promise<Snapshot> {
    const cached = this.snapshots.get(machineId);
    if (!fresh && cached && performance.now() - cached.at < 1500) return cached;
    const started = performance.now(), reverse = await this.list(serial, "reverse"), forward = await this.list(serial, "forward");
    const value = { started, at: performance.now(), reverse, forward };
    this.snapshots.set(machineId, value);
    return value;
  }
  /** One shared check per machine and second, for every tunnel of that lease: the device is
   * still this lease's (supervisor, authorization, serial), and every installed mapping still
   * exists. It depends on the device only, never on one tunnel's own authorization, so closing
   * one tunnel cannot end its siblings. */
  private alive(machine: RecordValue, image: RecordValue, serial: string): Promise<void> {
    const id = uuid(machine.id), cached = this.liveness.get(id), now = performance.now();
    if (cached && now - cached.at < 900) return cached.check;
    const next = (async () => {
      await this.provider.ownedLive(machine, image, serial);
      // A mapping can vanish while the lease lives: an adb server restart drops forward listeners
      // and a transport reset drops reverse ones. The tunnel would stay ready and carry nothing.
      // Only a readable list that lacks the mapping counts; a failed list proves nothing.
      let lists: Snapshot;
      try { lists = await this.snapshot(id, serial, false); } catch { return; }
      for (const tunnel of this.live.values()) {
        if (tunnel.machineId !== id || tunnel.closing || tunnel.installedAt === undefined || tunnel.installedAt >= lists.started) continue;
        if (!(tunnel.direction === "reverse" ? lists.reverse : lists.forward).some(entry => this.match(entry, tunnel, serial))) tunnel.lost = true;
      }
    })();
    this.liveness.set(id, { at: now, check: next }); void next.catch(() => {});
    return next;
  }

  /** Installs one mapping and returns its host-side endpoint. `onConnection` receives every
   * connection the device makes to a reverse tunnel's port. */
  async open(machine: RecordValue, image: RecordValue, spec: TunnelSpec, check: Authorized, onConnection: (socket: Socket) => void): Promise<TunnelEndpoint> {
    const provider = this.provider, id = uuid(spec.id), machineId = uuid(machine.id);
    provider.executionAllowed(machine); await authorized(check);
    const direction = spec.direction, devicePort = integer(spec.devicePort, "device port", 1, 65535);
    if (direction !== "reverse" && direction !== "forward" || image.os !== "android" || machine.lease == null || machine.desired !== "running") throw new ServiceError("Lease tunnels need a running leased Android assignment.", 409, { code: "capability_unsupported" });
    const storage = provider.storage(machine, image), file = this.file(storage, id);
    const serial = await provider.endpoint(machine, storage, check);
    if (!serial) throw new ServiceError("Android device is not connected.", 409);
    if (this.live.has(id)) throw new ServiceError("Tunnel identity is already in use on this runner.", 409);
    privateDirectory(path.join(storage, SOCKET_DIRECTORY));
    if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new ServiceError("Tunnel socket path is already occupied.", 409);
    const tunnel: Live = { id, direction, devicePort, machineId, file, serial };
    // Registered before the mapping exists, so a concurrent audit never mistakes it for a foreign one.
    this.live.set(id, tunnel);
    let installing = false;
    try {
      if (direction === "reverse") {
        const sockets = new Set<Socket>();
        const server = createServer({ allowHalfOpen: true }, socket => {
          socket.on("error", () => {}); sockets.add(socket); socket.once("close", () => sockets.delete(socket));
          onConnection(socket);
        });
        server.on("error", () => {});
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(file, () => { server.removeListener("error", reject); resolve(); }); });
        this.servers.set(id, { server, sockets }); fs.chmodSync(file, 0o600);
      }
      await authorized(check);
      installing = true;
      // --no-rebind: a port that already has a mapping, ours or not, is never silently taken over.
      await provider.adb(serial, direction === "reverse" ? ["reverse", "--no-rebind", `tcp:${devicePort}`, `localfilesystem:${file}`] : ["forward", "--no-rebind", `localfilesystem:${file}`, `tcp:${devicePort}`], { timeoutMs: ADB_MS });
      if (!(await this.list(serial, direction)).some(entry => this.match(entry, tunnel, serial))) throw new ServiceError("The device port mapping was not confirmed.", 409, { outcome: "unknown" });
      if (direction === "forward") { try { fs.chmodSync(file, 0o600); } catch { /* The directory's mode already limits who can open it. */ } }
      tunnel.installedAt = performance.now(); this.snapshots.delete(machineId);
      await authorized(check);
    } catch {
      const removed = await this.remove(machine, image, tunnel, installing, check);
      throw new TunnelMappingError(removed);
    }
    let closing: Promise<{ mappingRemoved: boolean }> | undefined;
    return {
      connect: () => new Promise<Socket>((resolve, reject) => {
        if (direction !== "forward" || closing) { reject(new ServiceError("Tunnel endpoint is closed.", 410)); return; }
        const socket = connect({ path: file, allowHalfOpen: true });
        socket.once("error", reject); socket.once("connect", () => { socket.removeListener("error", reject); socket.on("error", () => {}); resolve(socket); });
      }),
      alive: async () => { await this.alive(machine, image, serial); if (tunnel.lost) throw new TunnelMappingLost(); },
      close: deviceAllowed => closing ??= this.remove(machine, image, tunnel, true, deviceAllowed).then(mappingRemoved => ({ mappingRemoved })),
    };
  }

  /** Closes the endpoint, then removes and verifies the mapping. A forward mapping is state of
   * the host's adb server and is removed without touching the device. A reverse mapping is state
   * of the guest's adb daemon: it is removed only while this runner still holds the device, and
   * otherwise ends with the emulator, which the lease's stop proof covers. */
  private async remove(machine: RecordValue, image: RecordValue, tunnel: Live, installed: boolean, deviceAllowed: Authorized): Promise<boolean> {
    const provider = this.provider;
    tunnel.closing = true;
    await this.closeServer(tunnel.id);
    let removed = !installed;
    if (installed) try {
      if (tunnel.direction === "forward") {
        await provider.adb(tunnel.serial, ["forward", "--remove", `localfilesystem:${tunnel.file}`], { timeoutMs: ADB_MS }).catch(() => {});
        removed = !(await this.list(tunnel.serial, "forward")).some(entry => entry.local === `localfilesystem:${tunnel.file}`);
      } else if (await deviceAllowed()) {
        await provider.ownedLive(machine, image, tunnel.serial, deviceAllowed);
        // `reverse --remove` names a device port only. Remove it only while that port still maps to
        // this tunnel's own socket, so a mapping this tunnel never owned is left alone.
        const mine = async (): Promise<boolean> => (await this.list(tunnel.serial, "reverse")).some(entry => this.match(entry, tunnel, tunnel.serial));
        if (await mine()) await provider.adb(tunnel.serial, ["reverse", "--remove", `tcp:${tunnel.devicePort}`], { timeoutMs: ADB_MS }).catch(() => {});
        removed = !await mine() && await deviceAllowed();
      }
    } catch { removed = false; }
    try { fs.unlinkSync(tunnel.file); } catch { /* Already gone, or removed with the lease's storage. */ }
    this.live.delete(tunnel.id); this.snapshots.delete(tunnel.machineId);
    return removed;
  }

  /** Read-only: true when no mapping of this ended tunnel remains. Used to confirm a removal that
   * could not be proven when the tunnel closed, for example after a runner restart. */
  async absent(machine: RecordValue, image: RecordValue, spec: TunnelSpec, check: Authorized): Promise<boolean> {
    const provider = this.provider;
    provider.executionAllowed(machine); await authorized(check);
    if (this.live.has(uuid(spec.id))) return false;
    const storage = provider.storage(machine, image), file = this.file(storage, spec.id), serial = await provider.endpoint(machine, storage, check);
    if (!serial) return false;
    const entries = await this.list(serial, spec.direction);
    await authorized(check);
    return !entries.some(entry => (spec.direction === "reverse" ? entry.remote : entry.local) === `localfilesystem:${file}`);
  }

  /** The device may hold only mappings that lead into this lease's own socket directory. One that
   * belongs to an open tunnel is expected. One without an open tunnel is the residue of a closed
   * tunnel (an unconfirmed removal or a runner restart): its socket no longer exists and its name
   * is never reused, so it reaches nothing; it is removed here on a best-effort basis and never
   * makes the device unready. Any other entry was not created by a tunnel: `foreign`. A list that
   * cannot be read for this device is `inconclusive`; other devices' lines are never judged.
   * Throttled to once a second per boot after it first passed. Runs only on a host that declares
   * tunnels (AndroidProvider.leasedReadiness). */
  async audit(machine: RecordValue, serial: string, storage: string, boot: unknown): Promise<"clean" | "foreign" | "inconclusive"> {
    const provider = this.provider, machineId = uuid(machine.id), last = this.audited.get(machineId), now = performance.now();
    if (last && last.boot === boot && now - last.at < 1000) return "clean";
    const own = `localfilesystem:${path.join(storage, SOCKET_DIRECTORY)}${path.sep}`;
    const open = (): Live[] => [...this.live.values()].filter(tunnel => tunnel.machineId === machineId);
    try {
      const { reverse, forward } = await this.snapshot(machineId, serial, true);
      for (const entry of reverse) {
        if (open().some(tunnel => tunnel.direction === "reverse" && this.match(entry, tunnel, serial))) continue;
        if (!entry.remote.startsWith(own)) return "foreign";
        // Removal is by device port: never remove under a tunnel that is using that port now.
        if (open().some(tunnel => tunnel.direction === "reverse" && entry.local === `tcp:${tunnel.devicePort}`)) continue;
        await provider.adb(serial, ["reverse", "--remove", entry.local], { timeoutMs: ADB_MS }).catch(() => {});
      }
      for (const entry of forward) {
        if (open().some(tunnel => tunnel.direction === "forward" && this.match(entry, tunnel, serial))) continue;
        if (!entry.local.startsWith(own)) return "foreign";
        await provider.adb(serial, ["forward", "--remove", entry.local], { timeoutMs: ADB_MS }).catch(() => {});
      }
    } catch { return "inconclusive"; }
    this.audited.set(machineId, { boot, at: performance.now() });
    return "clean";
  }

  /** Lease end and cleanup: closes every host-side endpoint of this machine without device access. */
  async closeMachine(machineId: string): Promise<void> {
    const id = uuid(machineId);
    this.liveness.delete(id); this.audited.delete(id); this.snapshots.delete(id);
    for (const tunnel of [...this.live.values()]) if (tunnel.machineId === id) await this.closeServer(tunnel.id);
  }
  /** Stops listening and closes the connections the device already made. */
  private async closeServer(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) return;
    this.servers.delete(id);
    for (const socket of entry.sockets) socket.destroy();
    await new Promise<void>(resolve => { entry.server.close(() => resolve()); });
  }
}
