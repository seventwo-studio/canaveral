/** Linux guest service composition. Native effects occur only through the installed Rust adapters. */
import { randomUUID } from "node:crypto";
import { constants, existsSync, promises as fs, readFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ServiceError, object } from "../errors.ts";
import { SqliteStore } from "../sqlite.ts";
import { decodeData, fileIdentity, guestPath, jsonBytes, transferSize, uuid } from "../control/transfers.ts";
import type { PinnedDirectory } from "../control/transfers.ts";
import { validateSnapshot } from "../control/session-protocol.ts";
import { createNodeMobileTransport, nativeContainerFiles, nativeShells } from "../providers/mobile-native.ts";
import type { ContainerDirectory, ContainerFiles, MobileTransport, ShellAdapter, ShellConnection } from "../providers/mobile.ts";
import { dimensions } from "../providers/mobile.ts";
import { createGuestServer, createGuestServices } from "./server.ts";
import type { GuestServerServices, GuestServiceBindings } from "./server.ts";
import { integer, validUnicode } from "./https.ts";

export interface LinuxServiceOptions {
  nativeHelper?: string;
  atspiHelper?: string;
  stateDirectory?: string;
  preparedFile?: string;
  mode?: "desktop" | "headless";
  /** Fixture seams preserve the same protocol and never activate a native fallback. */
  files?: ContainerFiles;
  shells?: ShellAdapter;
  transport?: Pick<MobileTransport, "run">;
  stat?: (path: string) => Promise<BigIntStats>;
  ready?: () => boolean;
  clock?: () => number;
  environment?: Record<string, string>;
}
function linuxClock(): number {
  const now = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  if (!Number.isFinite(now) || now < 0) throw new ServiceError("The guest suspend-aware clock is unavailable.", 409);
  return now;
}
function components(path: string, directory: boolean): string[] {
  guestPath(path, "absolute", directory);
  return path.split("/").filter(p => p && p !== ".");
}
/** Every component is traversed relative to a Rust-owned O_NOFOLLOW directory handle. */
async function openDirectory(files: ContainerFiles, parts: string[]): Promise<ContainerDirectory> {
  let current = await files.openRoot("/");
  try {
    for (const part of parts) { const child = await current.directory(part); try { await current.close(); } catch (error) { await child.close().catch(() => {}); throw error; } current = child; }
    return current;
  } catch (error) { await current.close().catch(() => {}); throw error; }
}
function pinned(directory: ContainerDirectory): PinnedDirectory {
  return {
    exists: name => directory.exists(name), sync: () => directory.sync(),
    async createExclusive(name) {
      const stage = await directory.createExclusive(name);
      return {
        write: bytes => stage.write(bytes), sync: () => stage.sync(), close: () => stage.close(), cleanup: () => directory.removeOwned(name),
        async publish(destination, replace) { if (await directory.publishOwned(name, destination, replace) !== "published") throw new ServiceError("Guest destination already exists.", 409, { code: "download_destination_exists" }); },
      };
    },
  };
}
interface Terminal { connection: ShellConnection; seen: number; cols: number; rows: number; blocked: boolean; tail: Promise<unknown> }
interface Inspection { value: Record<string, unknown>; startedAt: number; expiresAt: number }
export function createLinuxServices(options: LinuxServiceOptions = {}): GuestServerServices {
  const native = options.nativeHelper ?? "/opt/canaveral/bin/canaveral-mobile-native", atspi = options.atspiHelper ?? "/opt/canaveral/bin/canaveral-guest-agent";
  const files = options.files ?? nativeContainerFiles(native), shells = options.shells ?? nativeShells(native), transport = options.transport ?? createNodeMobileTransport({ nativeHelper: native });
  const clock = options.clock ?? linuxClock, stat = options.stat ?? (path => fs.stat(path, { bigint: true })), env = options.environment ?? process.env as Record<string, string>;
  const store = new SqliteStore(join(options.stateDirectory ?? "/opt/canaveral/state", "terminals.sqlite"));
  store.transaction(db => { db.exec("CREATE TABLE IF NOT EXISTS guest_linux_terminals(id TEXT PRIMARY KEY,cols INTEGER NOT NULL,rows INTEGER NOT NULL,state TEXT NOT NULL)"); });
  const sessions = new Map<string, Terminal>(), inspections = new Map<string, Inspection>(); let closed = false;
  const pendingOpens = new Set<Promise<Record<string, unknown>>>();
  const alive = () => { if (closed) throw new ServiceError("Guest services are stopping.", 410); };
  const mark = (id: string, state: string) => store.transaction(db => { db.prepare("UPDATE guest_linux_terminals SET state=? WHERE id=?").run(state, id); });
  const closeTerminal = async (id: string, t: Terminal) => {
    t.blocked = true;
    try { mark(id, "closing"); } catch { /* A failed receipt must not prevent stopping the owned PTY. */ }
    try { await t.connection.close(); mark(id, "closed"); sessions.delete(id); }
    catch (error) { try { mark(id, "unknown"); } catch { /* The pending durable receipt still refuses reopening. */ } throw error; }
  };
  const shellControl = async (action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    alive(); const id = uuid(args.session);
    if (action === "shell-open") {
      const cols = args.cols ?? 80, rows = args.rows ?? 24;
      if (!integer(cols, 500) || !cols || !integer(rows, 500) || !rows) throw new ServiceError("Invalid guest terminal dimensions.", 400);
      const existing = sessions.get(id);
      if (existing && !existing.blocked && existing.cols === cols && existing.rows === rows) return { session: id };
      if (existing) throw new ServiceError("Guest terminal identity conflicts or needs cleanup.", 409);
      store.transaction(db => {
        if (db.prepare("SELECT id FROM guest_linux_terminals WHERE id=?").get(id)) throw new ServiceError("Terminal identity is retired or its prior process is uncertain. Open a fresh session.", 409);
        db.prepare("INSERT INTO guest_linux_terminals VALUES(?,?,?,'starting')").run(id, cols, rows);
      });
      let connection: ShellConnection | undefined;
      try {
        connection = await shells.open(["/bin/bash", "-il"], env);
        const terminal = { connection, cols, rows, seen: clock(), blocked: true, tail: Promise.resolve() };
        sessions.set(id, terminal); alive(); await connection.resize(rows, cols); alive(); mark(id, "open"); terminal.blocked = false;
        return { session: id };
      } catch (error) {
        const retained = sessions.get(id); if (retained) retained.blocked = true;
        if (connection) { try { await connection.close(); sessions.delete(id); } catch { /* Retain live uncertain session for explicit cleanup. */ } }
        try { mark(id, "unknown"); } catch { /* The starting receipt remains conservative. */ }
        throw error;
      }
    }
    const t = sessions.get(id); if (!t) throw new ServiceError("Terminal is closed or its guest helper restarted. Open a new session.", 404);
    const work = t.tail.then(async () => {
      alive(); if (t.blocked && action !== "shell-close" && action !== "shell-read") throw new ServiceError("Terminal input is fenced; inspect before retrying.", 409, { outcome: "unknown", retryable: false });
      t.seen = clock();
      if (action === "shell-close") { await closeTerminal(id, t); return { closed: true }; }
      if (action === "shell-write") {
        const text = args.text;
        if (typeof text !== "string" || !validUnicode(text) || text.includes("\0") || [...text].length > 16000) throw new ServiceError("Invalid terminal text.", 400);
        jsonBytes({ session: id, text }, 16384);
        try { const r = await t.connection.write(text); if (r.written !== Buffer.byteLength(text)) throw new Error(); return { written: r.written }; }
        catch { t.blocked = true; mark(id, "unknown"); throw new ServiceError("Terminal input acknowledgement was not confirmed; input will not be replayed.", 409, { outcome: "unknown", retryable: false }); }
      }
      if (action === "shell-resize") {
        if (!integer(args.cols, 500) || !args.cols || !integer(args.rows, 500) || !args.rows) throw new ServiceError("Invalid terminal dimensions.", 400);
        await t.connection.resize(args.rows, args.cols); return { resized: true };
      }
      if (action !== "shell-read") throw new ServiceError("Unsupported terminal control.", 400);
      const offset = args.offset ?? 0; transferSize(offset);
      const result = await t.connection.read(offset as number), end = transferSize(result.offset), data = decodeData(result.data, 1048576);
      if (end < (offset as number) || data.length > end || typeof result.exited !== "boolean" || typeof result.truncated !== "boolean" || (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) ||
        (!result.truncated && end - (offset as number) !== data.length) || (result.truncated && end - data.length <= (offset as number))) throw new ServiceError("Malformed native terminal output.", 409);
      const tail = data.subarray(Math.max(0, data.length - 65536)), truncated = end - tail.length > (offset as number);
      return { session: id, data: tail.toString("base64"), offset: end, truncated, exited: result.exited && !tail.length, exitCode: result.exitCode };
    });
    t.tail = work.catch(() => {}); return work;
  };
  const screenshot = async (): Promise<Record<string, unknown>> => {
    alive(); const folder = await fs.mkdtemp(join(tmpdir(), "canaveral-screen-")), path = join(folder, "frame.png");
    try {
      const result = await transport.run(["scrot", "-o", path], { env, timeoutMs: 5000, maxBytes: 65536 });
      if (result.exitCode !== 0) throw new ServiceError("Native guest capture failed.", 409);
      const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await file.stat(); if (!metadata.isFile() || metadata.size > 4 * 1048576) throw new ServiceError("Desktop frame exceeds 4 MiB.", 413);
        const data = await file.readFile(); if (data.length > 4 * 1048576) throw new ServiceError("Desktop frame exceeds 4 MiB.", 413);
        const [width, height] = dimensions(data); return { id: randomUUID(), capturedAt: Date.now() / 1000, width, height, data: data.toString("base64"), mediaType: "image/png" };
      } finally { await file.close(); }
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  };
  const inspect = async (includeFrame: boolean): Promise<Record<string, unknown>> => {
    alive();
    const result = await transport.run([atspi, "--atspi-inspect", "--guest-confirmed"], { env, timeoutMs: 5000, maxBytes: 6 * 1048576 });
    if (result.exitCode !== 0) throw new ServiceError("Native AT-SPI inspection is unavailable.", 409, { code: "input_rejected", retryable: false });
    const bytes = typeof result.stdout === "string" ? Buffer.from(result.stdout) : result.stdout;
    const native = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (typeof native.startedAt !== "number" || !Number.isFinite(native.startedAt) || typeof native.expiresAt !== "number" || !Number.isFinite(native.expiresAt) || native.expiresAt - native.startedAt !== 15) throw new ServiceError("Invalid native inspection lifetime.", 409);
    const value = { ...native, snapshotId: randomUUID(), capturedAt: Date.now() / 1000, source: "linux-atspi", coordinateSpace: "screen-pixels", coverage: "Native AT-SPI data. Custom-rendered controls may be absent; an empty tree does not imply an empty desktop." };
    validateSnapshot(value); jsonBytes(value, 6 * 1048576);
    const now = clock(); if (now < native.startedAt || now >= native.expiresAt) throw new ServiceError("Native capture expired before acknowledgement.", 409, { code: "input_rejected" });
    for (const [id, entry] of inspections) if (now < entry.startedAt || now >= entry.expiresAt) inspections.delete(id);
    inspections.set(value.snapshotId, { value: structuredClone(value), startedAt: native.startedAt, expiresAt: native.expiresAt });
    return includeFrame ? { ...value, frame: await screenshot() } : value;
  };
  const action = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    alive(); const id = uuid(args.snapshotId), entry = inspections.get(id), now = clock();
    if (!entry || now < entry.startedAt || now >= entry.expiresAt) { inspections.delete(id); throw new ServiceError("Accessibility target expired. Inspect again.", 409, { code: "input_rejected", retryable: false }); }
    if (typeof args.nodeId !== "string" || typeof args.nativeAction !== "string") throw new ServiceError("Invalid native accessibility target.", 400);
    const nodes = entry.value.nodes as Record<string, unknown>[], map = new Map(nodes.map(n => [n.id, n])), chain: Record<string, unknown>[] = []; let current = map.get(args.nodeId);
    if (!current || !(current.actions as string[]).includes(args.nativeAction)) throw new ServiceError("Native action is not exposed by the inspected target.", 409, { code: "input_rejected", retryable: false });
    while (current) { chain.unshift(current); if (chain.length > 31) throw new ServiceError("Invalid inspection lineage.", 409, { code: "input_rejected" }); current = current.parentId === null ? undefined : map.get(current.parentId); }
    const input = jsonBytes({ chain, action: args.nativeAction, startedAt: entry.startedAt, expiresAt: entry.expiresAt }, 6 * 1048576);
    // Consume before native dispatch, including a timeout that loses the posted acknowledgement.
    inspections.delete(id);
    const result = await transport.run([atspi, "--atspi-action", "--guest-confirmed"], { env, input, timeoutMs: 5000, maxBytes: 4096 });
    if (result.exitCode === 42) throw new ServiceError("Accessibility target changed or is unavailable. Inspect again.", 409, { code: "input_rejected", retryable: false });
    // A possibly-posted action consumes its context and is never retried automatically.
    if (result.exitCode !== 0) throw new ServiceError("Accessibility action outcome was not confirmed.", 409, { outcome: "unknown", retryable: false });
    return { posted: true };
  };
  const bindings: GuestServiceBindings = {
    ready: options.ready ?? (() => existsSync(options.preparedFile ?? "/opt/canaveral/prepared")),
    shells: { async control(action, args) {
      const work = shellControl(action, args);
      if (action !== "shell-open") return work;
      pendingOpens.add(work);
      try { return await work; } finally { pendingOpens.delete(work); }
    } },
    files: {
      async list(path) {
        alive(); const directory = await openDirectory(files, components(path, true));
        try {
          const entries = await directory.list(); entries.sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          const metadata: Record<string, unknown>[] = [];
          for (const entry of entries.slice(0, 2000)) {
            try { const info = await stat(join(path, entry.name)); metadata.push({ ...entry, size: transferSize(Number(info.size)), modifiedAt: Number(info.mtimeNs) / 1e9 }); }
            catch { metadata.push({ ...entry, unavailable: true }); }
          }
          return { path, entries: metadata, truncated: entries.length > 2000 };
        }
        finally { await directory.close(); }
      },
      async parent(path) { alive(); const parts = components(path, false), name = parts.pop()!; const directory = await openDirectory(files, parts); return { directory: pinned(directory), name, close: () => directory.close() }; },
      async download(path) {
        alive(); const parts = components(path, false), name = parts.pop()!, before = await stat(path);
        if (!before.isFile()) throw new ServiceError("Downloads require a regular file.", 409);
        const identity = fileIdentity(before), directory = await openDirectory(files, parts); let source: Awaited<ReturnType<ContainerDirectory["download"]>> | undefined;
        try {
          source = await directory.download(name); const retained = source;
          if (fileIdentity(await stat(path)) !== identity || retained.size !== Number(before.size) || await retained.verify() !== true) throw new ServiceError("Download path identity changed while opening.", 409);
          await directory.close();
          return { size: retained.size, identity, read: count => retained.read(count), verify: async () => await retained.verify() === true && fileIdentity(await stat(path)) === identity, close: () => retained.close() };
        } catch (error) { await source?.close().catch(() => {}); await directory.close().catch(() => {}); throw error; }
      },
    },
    ...(options.mode === "headless" ? {} : { graphics: { screenshot, inspect, action } }),
  };
  const services = createGuestServices(bindings);
  const sweep = setInterval(() => {
    let now: number;
    try { now = clock(); }
    catch { closed = true; clearInterval(sweep); void Promise.allSettled([...sessions].map(([id, terminal]) => closeTerminal(id, terminal))); return; }
    for (const [id, terminal] of sessions) if (!terminal.blocked && (now < terminal.seen || now - terminal.seen >= 600)) {
      terminal.blocked = true; const work = terminal.tail.then(() => closeTerminal(id, terminal)); terminal.tail = work.catch(() => {});
    }
  }, 5000); sweep.unref();
  return { ...services, async close() {
    closed = true; clearInterval(sweep);
    await Promise.allSettled([...pendingOpens]);
    const results = await Promise.allSettled([...sessions].map(([id, t]) => { t.blocked = true; return t.tail.then(() => closeTerminal(id, t)); }));
    if (results.some(r => r.status === "rejected")) throw new ServiceError("Guest terminal cleanup remains uncertain.", 409, { outcome: "unknown", retryable: false });
    inspections.clear();
  } };
}
/** Explicit guest-only executable entry. Host construction/import never starts this service. */
export async function startLinuxGuest(argv: string[] = process.argv.slice(2)): Promise<ReturnType<typeof createGuestServer>> {
  if (process.platform !== "linux" || process.getuid?.() === 0 || argv.length !== 2 || argv[1] !== "--guest-confirmed") throw new ServiceError("Run this service as an unprivileged user in an isolated Linux guest with --guest-confirmed.", 400);
  const tokenPath = resolve(argv[0]!), handle = await fs.open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let token: string;
  try { const metadata = await handle.stat(); if (!metadata.isFile() || metadata.size > 4096 || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) throw new ServiceError("Guest credential must be a private owned regular file.", 400); token = (await handle.readFile("utf8")).trim(); } finally { await handle.close(); }
  const mode = process.env.CANAVERAL_GUEST_MODE ?? "desktop";
  if (mode !== "desktop" && mode !== "headless") throw new ServiceError("Invalid guest service mode.", 400);
  const root = dirname(tokenPath);
  // Preparation may only acknowledge readiness after both mandatory native helpers exist.
  for (const executable of [join(root, "bin/canaveral-mobile-native"), ...(mode === "desktop" ? [join(root, "bin/canaveral-guest-agent")] : [])]) await fs.access(executable, constants.X_OK);
  const services = createLinuxServices({ mode, stateDirectory: join(root, "state"), preparedFile: join(root, "prepared"), nativeHelper: join(root, "bin/canaveral-mobile-native"), atspiHelper: join(root, "bin/canaveral-guest-agent") });
  const server = createGuestServer({ mode, token, services });
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8769, "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
  catch (error) { await services.close?.(); throw error; }
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections(); void services.close?.().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return server;
}
