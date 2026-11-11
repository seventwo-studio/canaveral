/** Scoped consumer SDK. Persist every caller-owned UUID and intent before dispatch.
 * No method retries input, reconnects, renews a lease implicitly, or rotates a key implicitly.
 */
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { constants, openSync, fstatSync, readSync, closeSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  ConsumerClient as HttpConsumerClient, LeaseClient as HttpLeaseClient, Transport,
  ConsumerError, ConsumerConfigurationError, ConsumerProtocolError,
} from './consumer-client.ts';
import type { ApplicationClientOptions, LeaseClientOptions, ClientOptions, RenewRequest, ReleaseRequest, ReadOptions, Lease, Capability } from './consumer-client.ts';
import { TerminalClient } from './terminal-sdk.ts';
import { DisplayClient } from './visual-sdk.ts';
import type { DisplayOptions } from './visual-sdk.ts';
import { receiveSnapshot, MAX_SNAPSHOT_BYTES } from './accessibility-sdk.ts';
import { FilePublicationError, scopedDownloadFiles } from './sdk-files.ts';
import type { DownloadDirectory, DownloadFiles } from './sdk-files.ts';
export { containerDownloadFiles, linuxDownloadFiles, scopedDownloadFiles, windowsDownloadFiles } from './sdk-files.ts';
export type { DownloadDirectory, DownloadFiles, DownloadStage, PublishResult, WindowsPublicationAPI, WindowsPublicationBridge } from './sdk-files.ts';
export * from './consumer-client.ts';
export { TerminalClient, DisplayClient };
export { validateSnapshot, snapshotSchema } from './accessibility-sdk.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new ConsumerConfigurationError('A persisted UUID is required.', 'invalid_request');
  return value.toLowerCase();
}
export function timeout(value: number, zero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0) || value > 300_000) throw new ConsumerConfigurationError('Choose a finite timeout in milliseconds, at most 300000.');
  return value;
}
export function validText(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && wellFormed(value);
}
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export class SessionError extends ConsumerError {
  readonly status: number;
  constructor(message: string, code = 'session_protocol_error', requestId?: string, uncertain = true, status = 409) {
    super('SessionError', message, code, { ...(requestId ? { requestId } : {}), ...(uncertain ? { outcome: 'unknown' as const } : {}) });
    this.status = status;
  }
}
export function interrupted(error: unknown, requestId: string): ConsumerError {
  return new SessionError(error instanceof ConsumerError ? error.message : 'Session completion was not confirmed. Inspect before sending more input.',
    error instanceof ConsumerError ? error.code : 'session_incomplete', requestId);
}
const WORKER_MESSAGES: Record<string, string> = {
  capability_unsupported: 'This worker does not support the requested capability. Inspect the session before selecting another environment.',
  session_incomplete: 'Access ended without confirmed completion. Inspect before retrying.',
  upload_publication_uncertain: 'Upload publication may have occurred. Inspect the destination before retrying.',
};
export function checked<T>(value: T, requestId: string): T {
  if (record(value) && value.type === 'error') {
    if (Object.keys(value).sort().join(',') !== 'code,message,outcome,type' || typeof value.code !== 'string' ||
        !Object.hasOwn(WORKER_MESSAGES, value.code) || typeof value.message !== 'string' || value.outcome !== 'unknown') {
      throw new SessionError('Invalid worker error control; completion remains unknown.', 'session_protocol_error', requestId);
    }
    throw new SessionError(WORKER_MESSAGES[value.code]!, value.code, requestId);
  }
  return value;
}
export type SessionMessage = Buffer | Record<string, unknown>;
export interface SessionChannel {
  readonly sessionId: string;
  sendControl(value: Record<string, unknown>): Promise<void>;
  sendBytes(value: Uint8Array): Promise<void>;
  receive(timeoutMs?: number): Promise<SessionMessage | null>;
  close(): void;
}
/** Serializes one direction without blocking the other direction. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work); this.#tail = next.catch(() => {}); return next;
  }
}
export function controlBytes(value: Record<string, unknown>): Buffer {
  // JSON.stringify otherwise replaces nonfinite numbers and unpaired surrogates silently.
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if ((typeof item === 'number' && !Number.isFinite(item)) || (typeof item === 'string' && !wellFormed(item)) ||
        typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined) throw new ConsumerConfigurationError('Invalid JSON control.', 'invalid_request');
    return item;
  });
  // Match Python's ensure_ascii controls, including the byte budget for astral text.
  const bytes = Buffer.from(text.replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')));
  if (bytes.length > 16384) throw new ConsumerConfigurationError('Session controls must fit 16 KiB.', 'invalid_request');
  return bytes;
}

/** RFC 6455 client using Node streams. One assembled inbound message; fragmented
 * controls and binary data retain distinct semantics. No extensions are negotiated.
 */
export class SessionConnection implements SessionChannel {
  readonly sessionId: string;
  #socket: Duplex;
  #closed = false;
  #failure: unknown;
  #workerFailure: unknown;
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentSize = 0;
  #opcode = 0;
  #message: SessionMessage | undefined;
  #wake: (() => void) | undefined;
  #reads = new Serial();
  #writes = new Serial();
  private constructor(socket: Duplex, head: Buffer, sessionId: string) {
    this.#socket = socket; this.sessionId = sessionId; this.#buffer = head;
    socket.on('data', (data: Buffer) => {
      // Stop after one assembled message; stream.pause provides backpressure.
      this.#buffer = Buffer.concat([this.#buffer, data]); this.#pump();
    });
    socket.on('error', () => this.#fail(new SessionError('Session connection failed; input is not replayed.', 'session_incomplete', sessionId)));
    socket.on('end', () => this.#fail(new SessionError('Session disconnected; input is not replayed.', 'session_disconnected', sessionId)));
    socket.on('close', () => this.#fail(new SessionError('Session disconnected; input is not replayed.', 'session_disconnected', sessionId)));
    this.#pump();
  }
  static async connect(transport: Transport, path: string, sessionId: string): Promise<SessionConnection> {
    const { socket, head } = await transport.openSession(path);
    return new SessionConnection(socket, head, identifier(sessionId));
  }
  get closed(): boolean { return this.#closed; }
  #fail(error: unknown): void { this.#failure ??= error; this.close(); }
  close(): void { if (!this.#closed) { this.#closed = true; this.#socket.destroy(); this.#wake?.(); } }
  [Symbol.dispose](): void { this.close(); }
  #check(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new SessionError('Session connection ended; no input is replayed.', 'session_disconnected', this.sessionId);
  }
  #pump(): void {
    try {
      while (!this.#closed && this.#message === undefined) {
        const b = this.#buffer;
        if (b.length < 2) break;
        const first = b[0]!, second = b[1]!, fin = (first & 128) !== 0, op = first & 15;
        if ((first & 112) || (second & 128) || ![0, 1, 2, 8, 9, 10].includes(op)) throw new Error('frame');
        let size = second & 127, offset = 2;
        if (size === 126) { if (b.length < 4) break; size = b.readUInt16BE(2); offset = 4; if (size < 126) throw new Error('length'); }
        else if (size === 127) {
          if (b.length < 10) break;
          const n = b.readBigUInt64BE(2); if (n < 65536n || n > 65536n) throw new Error('length');
          size = Number(n); offset = 10;
        }
        if (op >= 8) { if (!fin || size > 125) throw new Error('control'); }
        else {
          if ((op === 0 && !this.#opcode) || (op !== 0 && this.#opcode)) throw new Error('fragment');
          const kind = op || this.#opcode;
          if (size + this.#fragmentSize > (kind === 1 ? 16384 : 65536)) throw new Error('envelope');
        }
        if (b.length < offset + size) break;
        const data = b.subarray(offset, offset + size); this.#buffer = b.subarray(offset + size);
        if (op === 8) { if (size === 1) throw new Error('close'); this.#fail(new SessionError('Session disconnected.', 'session_disconnected', this.sessionId)); break; }
        if (op === 9) { void this.#sendFrame(10, data).catch(error => this.#fail(error)); continue; }
        if (op === 10) continue;
        if (op !== 0) this.#opcode = op;
        this.#fragments.push(data); this.#fragmentSize += size;
        if (!fin) continue;
        const payload = Buffer.concat(this.#fragments, this.#fragmentSize);
        if (this.#opcode === 1) {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
          if (!record(value)) throw new Error('control object');
          this.#message = value;
          try { checked(value, this.sessionId); } catch (error) { this.#workerFailure = error; }
        } else this.#message = payload;
        this.#fragments = []; this.#fragmentSize = 0; this.#opcode = 0;
      }
      if (this.#message !== undefined || this.#closed) this.#socket.pause();
      else this.#socket.resume();
      this.#wake?.();
    } catch { this.#fail(new SessionError('Invalid or oversized session message.', 'session_protocol_error', this.sessionId)); }
  }
  #sendFrame(opcode: number, data: Buffer): Promise<void> {
    return this.#writes.run(async () => {
      this.#check(); if (this.#workerFailure) throw this.#workerFailure;
      const n = data.length, header = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
      header[0] = 128 | opcode;
      if (n < 126) header[1] = 128 | n;
      else if (n < 65536) { header[1] = 254; header.writeUInt16BE(n, 2); }
      else { header[1] = 255; header.writeBigUInt64BE(BigInt(n), 2); }
      const mask = randomBytes(4), bytes = Buffer.alloc(n);
      for (let i = 0; i < n; i++) bytes[i] = data[i]! ^ mask[i % 4]!;
      await new Promise<void>((resolveWrite, reject) => {
        const timer = setTimeout(() => { this.close(); reject(new SessionError('Session write timed out; input may have been delivered.', 'session_incomplete', this.sessionId)); }, 30_000);
        this.#socket.write(Buffer.concat([header, mask, bytes]), error => {
          clearTimeout(timer);
          if (error) { this.close(); reject(new SessionError('Session write failed; input may have been delivered.', 'session_incomplete', this.sessionId)); }
          else resolveWrite();
        });
      });
    });
  }
  sendControl(value: Record<string, unknown>): Promise<void> {
    if (!record(value)) throw new ConsumerConfigurationError('A session control must be an object.');
    return this.#sendFrame(1, controlBytes(value));
  }
  sendBytes(value: Uint8Array): Promise<void> {
    if (!(value instanceof Uint8Array) || value.byteLength > 65536) throw new ConsumerConfigurationError('Session binary messages must fit 64 KiB.');
    return this.#sendFrame(2, Buffer.from(value));
  }
  receive(timeoutMs = 30_000): Promise<SessionMessage | null> {
    timeout(timeoutMs, true);
    return this.#reads.run(async () => {
      const deadline = performance.now() + timeoutMs;
      while (true) {
        if (this.#message !== undefined) {
          const message = this.#message; this.#message = undefined; this.#pump(); return message;
        }
        this.#check();
        const left = deadline - performance.now(); if (left <= 0) return null;
        await new Promise<void>(done => {
          const timer = setTimeout(() => { this.#wake = undefined; done(); }, left);
          this.#wake = () => { clearTimeout(timer); this.#wake = undefined; done(); };
        });
      }
    });
  }
}

/** Opens a credential through one descriptor, checks ownership/mode, and bounds its contents. */
export function credentialFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new Error('private regular file');
    const data = Buffer.alloc(131); let used = 0;
    while (used < data.length) { const n = readSync(fd, data, used, data.length - used, null); if (!n) break; used += n; }
    const token = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, used)).trim();
    if (used > 130 || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('token');
    return token;
  } catch { throw new ConsumerConfigurationError('Credential file must contain a valid private token and be owned by the current user.', 'invalid_credential'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Low-level HTTP client for the public client.py surface, with verified TLS and no retry. */
export class Client {
  readonly transport: Transport;
  constructor(options: ClientOptions & { credential: string }) { this.transport = new Transport(options, options.credential); }
  async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (!/^\/v1\//.test(path) || /[#\r\n]/.test(path)) throw new ConsumerConfigurationError('Invalid controller path.');
    const requestId = body?.id === undefined ? undefined : identifier(body.id);
    return (await this.transport.call(method, path, body, [200, 201, 202, 204], method !== 'GET', requestId)).json;
  }
}
export class ConsumerClient extends HttpConsumerClient {
  #options: ClientOptions;
  constructor(options: ApplicationClientOptions) {
    const pinned = { ...options };
    if (options.caFile !== undefined) {
      if (options.ca !== undefined) throw new ConsumerConfigurationError('Pass ca or caFile, not both.');
      try { pinned.ca = readFileSync(options.caFile); } catch { throw new ConsumerConfigurationError('The CA file could not be read.', 'invalid_ca'); }
      delete pinned.caFile;
    } else if (Buffer.isBuffer(options.ca)) pinned.ca = Buffer.from(options.ca);
    // Pin and validate trust once before any non-idempotent rotation.
    super(pinned);
    const { applicationKey: _key, ...base } = pinned; this.#options = base;
  }
  static fromCredentialFile(options: ClientOptions & { credentialFile: string }): ConsumerClient {
    return new ConsumerClient({ ...options, applicationKey: credentialFile(options.credentialFile) });
  }
  /** Explicit non-idempotent exchange. Losing this reply can revoke the previous key. */
  async scopedLease(leaseId: string): Promise<LeaseClient> {
    const result = await this.rotateLeaseCredential(leaseId);
    return new LeaseClient({ ...this.#options, leaseId: result.id, leaseKey: result.credential });
  }
  acquire = this.acquireLease.bind(this);
  leases = this.listLeases.bind(this);
  inspect = this.inspectLease.bind(this);
  renew = this.renewLease.bind(this);
  release = this.releaseLease.bind(this);
}
export type SessionCapability = 'pty' | 'upload' | 'download' | 'display' | 'accessibility';
export interface AccessSession extends Record<string, unknown> {
  id: string; leaseId: string; member: string; generation: string; capability: SessionCapability; protocol: 'canaveral-session-v1';
}
export interface SessionRequest { id: string; member: string; capability: SessionCapability }
export interface Reader { read(size: number): Uint8Array | null | Promise<Uint8Array | null> }
export interface Writer { write(data: Uint8Array): number | Promise<number> }
export interface TransferFinish extends Record<string, unknown> { type: 'finish'; bytes: number; sha256: string }
export interface DurableOperationRequest { id: string; member: string; action: string; arguments: Record<string, unknown> }
export interface DurableOperation extends Record<string, unknown> {
  id: string; leaseId: string; member: string; state: 'queued' | 'succeeded' | 'failed' | 'unknown'; updatedAt: string;
}
export type OperationRequest = DurableOperationRequest;
export type Operation = DurableOperation;
export interface CreateOperationResult { created: boolean; operation: DurableOperation }
export function operationRequest(request: DurableOperationRequest): DurableOperationRequest {
  const fields: Record<string, string[]> = {
    screenshot: [], hierarchy: [], apps: [], logs: [], accessibility: [], tap: ['x', 'y'], swipe: ['x', 'y', 'toX', 'toY', 'durationMs'],
    text: ['text'], key: ['key'], install: ['artifact'], uninstall: ['app'], launch: ['app'], terminate: ['app'], 'open-url': ['url'],
    location: ['latitude', 'longitude'], push: ['path', 'data'], pull: ['path'], shell: ['argv'], permission: ['app', 'permission', 'state'],
    rotate: ['orientation'], 'accessibility-action': ['snapshotId', 'nodeId', 'nativeAction'], 'list-files': ['path'],
    'shell-open': ['session'], 'shell-read': ['session', 'offset'], 'shell-write': ['session', 'text'], 'shell-close': ['session'], 'shell-resize': ['session', 'rows', 'cols'],
  };
  if (!record(request) || Object.keys(request).sort().join(',') !== 'action,arguments,id,member' || !validText(request.member) || !request.member || request.member.length > 100 || !record(request.arguments)) throw new ConsumerConfigurationError('Invalid durable operation.');
  if (typeof request.action !== 'string' || !Object.hasOwn(fields, request.action)) throw new ConsumerConfigurationError('Unsupported operation action.');
  const id = identifier(request.id), expected = fields[request.action], args = request.arguments;
  const allowed = [...(expected ?? []), ...(request.action === 'shell' ? ['timeoutMs'] : []), ...(['push', 'pull', 'list-files'].includes(request.action) ? ['app'] : [])];
  if (!expected || !expected.every(k => Object.hasOwn(args, k)) || Object.keys(args).some(k => !allowed.includes(k))) throw new ConsumerConfigurationError('Invalid operation arguments.');
  const invalid = () => { throw new ConsumerConfigurationError('Invalid operation argument.'); };
  for (const [key, value] of Object.entries(args)) {
    if (key === 'timeoutMs') { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 3600000) invalid(); }
    else if (key === 'session') identifier(value);
    else if (key === 'offset') { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(); }
    else if (['rows', 'cols', 'durationMs', 'x', 'y', 'toX', 'toY'].includes(key)) {
      const dimensions = ['rows', 'cols'].includes(key), duration = key === 'durationMs';
      if (!Number.isInteger(value) || Number(value) < (dimensions || duration ? 1 : 0) || Number(value) > (dimensions ? 500 : duration ? 10000 : 32768)) invalid();
    } else if (key === 'latitude' || key === 'longitude') {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > (key === 'latitude' ? 90 : 180)) invalid();
    } else if (key === 'argv') {
      if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(v => !validText(v) || [...v].length > 4096) || !value[0] || value[0].startsWith('-')) invalid();
    } else if (key === 'data') {
      if (typeof value !== 'string' || value.length > 700000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || Buffer.from(value, 'base64').length > 524288) invalid();
    } else if (!validText(value) || [...value].length > (key === 'text' ? 16000 : 4096) || (key !== 'text' && (!value || value.startsWith('-')))) invalid();
  }
  if (args.app !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.]*(?:\/[A-Za-z0-9_.$]+)?(?![\s\S])/.test(String(args.app))) invalid();
  if (request.action === 'permission' && !['grant', 'revoke', 'reset'].includes(String(args.state))) invalid();
  if (request.action === 'rotate' && !['PORTRAIT', 'PORTRAIT_UPSIDE_DOWN', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT'].includes(String(args.orientation))) invalid();
  return { id, member: request.member, action: request.action, arguments: { ...args } };
}
function length(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ConsumerConfigurationError('Byte count must be a nonnegative safe integer.');
  return value;
}
function boundSession(value: unknown, leaseId: string, id: string): AccessSession {
  if (!record(value) || value.id !== id || value.leaseId !== leaseId || typeof value.member !== 'string' || !value.member || value.protocol !== 'canaveral-session-v1' ||
      !['pty', 'upload', 'download', 'display', 'accessibility'].includes(String(value.capability))) throw new Error('session');
  identifier(value.generation); return value as AccessSession;
}
export interface WaitOptions {
  /** Total observation budget, including each HTTP read. Required; at most five minutes. */
  timeoutMs: number;
  /** Delay between successful nonterminal observations. Default 1000 ms, minimum 100 ms. */
  intervalMs?: number;
  signal?: AbortSignal;
}
export interface ReadyOptions extends WaitOptions { member?: string; requiredCapabilities?: Capability[] }
/** Observation stopped; this never asserts that a lease or command was cancelled. */
export class ConsumerWaitError extends ConsumerError {
  constructor(code: 'wait_timeout' | 'wait_aborted' | 'lease_terminal' | 'cleanup_blocked', requestId: string) {
    const messages = {
      wait_timeout: 'Observation deadline reached. Inspect the original resource before taking further action.',
      wait_aborted: 'Observation cancelled. The remote resource was not cancelled.',
      lease_terminal: 'The lease terminated before readiness was observed.',
      cleanup_blocked: 'Owned cleanup is blocked; capacity reclamation is not confirmed.',
    };
    super('ConsumerWaitError', messages[code], code, { requestId });
  }
}
async function observe<T>(id: string, options: WaitOptions, read: (options: ReadOptions) => Promise<T>, done: (value: T) => boolean): Promise<T> {
  timeout(options.timeoutMs);
  const interval = options.intervalMs ?? 1000;
  if (!Number.isInteger(interval) || interval < 100 || interval > 300000) throw new ConsumerConfigurationError('Polling interval must be 100 to 300000 milliseconds.');
  if (options.signal?.aborted) throw new ConsumerWaitError('wait_aborted', id);
  const deadline = performance.now() + options.timeoutMs, controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const stopped = () => {
    if (options.signal?.aborted) throw new ConsumerWaitError('wait_aborted', id);
    if (controller.signal.aborted || performance.now() >= deadline) throw new ConsumerWaitError('wait_timeout', id);
  };
  try {
    for (;;) {
      stopped();
      const value = await read({ timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), signal });
      stopped();
      if (done(value)) return value;
      await delay(Math.min(interval, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
  } catch (error) { stopped(); throw error; }
  finally { clearTimeout(timer); }
}
export class LeaseClient {
  readonly leaseId: string;
  readonly transport: Transport;
  #http: HttpLeaseClient;
  static fromCredentialFile(options: ClientOptions & { leaseId: string; credentialFile: string }): LeaseClient {
    return new LeaseClient({ ...options, leaseKey: credentialFile(options.credentialFile) });
  }
  constructor(options: LeaseClientOptions) { this.leaseId = identifier(options.leaseId); this.transport = new Transport(options, options.leaseKey); this.#http = new HttpLeaseClient(options); }
  get id(): string { return this.leaseId; }
  inspect(options?: ReadOptions) { return this.#http.inspect(options); }
  /** Explicit read-only polling; never acquires, renews, releases or rotates. */
  waitUntilReady(options: ReadyOptions): Promise<Lease> {
    const member = options.member ?? 'primary', required = options.requiredCapabilities ?? [];
    if (!validText(member) || !member || member.length > 100 || !Array.isArray(required) || required.some(c => !['command', 'pty', 'files', 'screenshot', 'displayStream', 'input', 'hierarchy'].includes(c)) || new Set(required).size !== required.length) throw new ConsumerConfigurationError('Invalid readiness requirements.');
    return observe(this.id, options, read => this.inspect(read), lease => {
      if (['failed', 'released', 'expired'].includes(lease.state)) throw new ConsumerWaitError('lease_terminal', this.id);
      const selected = lease.members.filter(m => m.name === member);
      return lease.state === 'ready' && selected.length === 1 && selected[0]!.ready === true && record(selected[0]!.capabilities) && required.every(c => lease.capabilities[c] === true && (selected[0]!.capabilities as Record<string, unknown>)[c] === true);
    });
  }
  /** Returns only after a terminal lease has positive cleanup completion. Does not release it. */
  waitForCleanup(options: WaitOptions): Promise<Lease> {
    return observe(this.id, options, read => this.inspect(read), lease => {
      if (lease.cleanup.state === 'blocked') throw new ConsumerWaitError('cleanup_blocked', this.id);
      return ['failed', 'released', 'expired'].includes(lease.state) && lease.cleanup.state === 'complete';
    });
  }
  /** Returns a terminal receipt, including failed or unknown; callers must inspect state. */
  waitForOperation(operationId: string, options: WaitOptions): Promise<DurableOperation> {
    const id = identifier(operationId);
    return observe(id, options, read => this.operation(id, read), operation => operation.state !== 'queued');
  }
  renew(request: RenewRequest) { return this.#http.renew(request); }
  release(request: ReleaseRequest) { return this.#http.release(request); }
  #operation(value: unknown, id: string): DurableOperation {
    if (!record(value) || value.id !== id || value.leaseId !== this.id || typeof value.member !== 'string' || !value.member ||
        !['queued', 'succeeded', 'failed', 'unknown'].includes(String(value.state)) || typeof value.updatedAt !== 'string' ||
        !value.updatedAt.endsWith('Z') || !Number.isFinite(Date.parse(value.updatedAt)) ||
        (value.state === 'succeeded' && !record(value.result)) ||
        (Object.hasOwn(value, 'result') && !record(value.result))) throw new Error('operation reply');
    return value as DurableOperation;
  }
  async createOperation(request: DurableOperationRequest): Promise<{ created: boolean; operation: DurableOperation }> {
    const body = operationRequest(request);
    const { status, json } = await this.transport.call('POST', `/v1/leases/${this.id}/operations`, body, [200, 201], true, body.id);
    try { const operation = this.#operation(json, body.id); if (operation.member !== body.member) throw new Error('member'); return { created: status === 201, operation }; }
    catch { throw new ConsumerProtocolError('Invalid operation receipt.', 'response_invalid', status, { requestId: body.id, outcome: 'unknown' }); }
  }
  async operation(operationId: string, options?: ReadOptions): Promise<DurableOperation> {
    const id = identifier(operationId), { status, json } = await this.transport.call('GET', `/v1/leases/${this.id}/operations/${id}`, undefined, [200], false, undefined, options);
    try { return this.#operation(json, id); } catch { throw new ConsumerProtocolError('Invalid operation receipt.', 'response_invalid', status, { requestId: id }); }
  }
  async #sessionCall(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, id: string, capability?: string, member?: string): Promise<AccessSession> {
    const { status, json } = await this.transport.call(method, path, body, [200, 201], method !== 'GET', method !== 'GET' ? id : undefined);
    try {
      const session = boundSession(json, this.leaseId, id);
      if (capability !== undefined && session.capability !== capability) throw new Error('capability');
      if (member !== undefined && session.member !== member) throw new Error('member');
      return session;
    } catch { throw new ConsumerProtocolError('The reply does not match the bound access session.', 'response_invalid', status, { requestId: id, ...(method !== 'GET' ? { outcome: 'unknown' as const } : {}) }); }
  }
  createSession(request: SessionRequest): Promise<AccessSession> {
    const id = identifier(request.id);
    if (Object.keys(request).some(k => !['id', 'member', 'capability'].includes(k)) || !validText(request.member) || !request.member.length || request.member.length > 100 ||
        !['pty', 'upload', 'download', 'display', 'accessibility'].includes(request.capability)) throw new ConsumerConfigurationError('Invalid session request.');
    return this.#sessionCall('POST', `/v1/leases/${this.id}/sessions`, { id, member: request.member, capability: request.capability }, id, request.capability, request.member);
  }
  session(sessionId: string): Promise<AccessSession> { const id = identifier(sessionId); return this.#sessionCall('GET', `/v1/leases/${this.id}/sessions/${id}`, undefined, id); }
  closeSession(sessionId: string): Promise<AccessSession> { const id = identifier(sessionId); return this.#sessionCall('POST', `/v1/leases/${this.id}/sessions/${id}/close`, {}, id); }
  async connectSession(session: AccessSession, timeoutMs = 30_000): Promise<SessionChannel> {
    timeout(timeoutMs);
    try { boundSession(session, this.id, identifier(session.id)); } catch { throw new ConsumerConfigurationError('Session must belong to this lease and protocol.'); }
    let connection: SessionConnection;
    try { connection = await SessionConnection.connect(this.transport, `/v1/leases/${this.id}/sessions/${session.id}/${session.generation}`, session.id); }
    catch (error) { throw interrupted(error, session.id); }
    try {
      const ready = checked(await connection.receive(timeoutMs), session.id);
      if (!record(ready) || ready.type !== 'ready' || ready.sessionId !== session.id || ready.generation !== session.generation || ready.capability !== session.capability) throw new SessionError('Session peers did not become ready. Inspect the original session; do not replay input.', 'session_incomplete', session.id);
      return connection;
    } catch (error) { connection.close(); throw error; }
  }
  async terminal(requestId: string, member = 'primary', timeoutMs = 30_000): Promise<TerminalClient> {
    timeout(timeoutMs);
    const session = await this.createSession({ id: requestId, member, capability: 'pty' });
    return new TerminalClient(await this.connectSession(session, timeoutMs), session.id);
  }
  async display(requestId: string, member = 'primary', options: DisplayOptions = {}): Promise<DisplayClient> {
    DisplayClient.validateOptions(options);
    const session = await this.createSession({ id: requestId, member, capability: 'display' });
    return DisplayClient.connect(await this.connectSession(session, options.timeoutMs), options);
  }
  async upload(requestId: string, member: string, path: string, reader: Reader, size: number, app?: string): Promise<TransferFinish> {
    size = length(size); filePath(path, app);
    const session = await this.createSession({ id: requestId, member, capability: 'upload' });
    const connection = await this.connectSession(session), hash = createHash('sha256'); let remaining = size;
    try {
      await connection.sendControl({ type: 'begin', path, size, ...(app === undefined ? {} : { app }) });
      while (remaining) {
        const data = await reader.read(Math.min(65536, remaining));
        if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > Math.min(65536, remaining)) throw new SessionError('Upload source ended early or returned an invalid chunk.', 'session_incomplete', requestId);
        hash.update(data); await connection.sendBytes(data); remaining -= data.byteLength;
      }
      const digest = hash.digest('hex');
      await connection.sendControl({ type: 'finish', bytes: size, sha256: digest });
      const result = checked(await connection.receive(), requestId);
      if (!finish(result, size, digest) || result.durable !== true) throw new SessionError('Upload publication was not confirmed. Inspect the destination.', 'session_incomplete', requestId);
      return result;
    } catch (error) { throw interrupted(error, requestId); } finally { connection.close(); }
  }
  async download(requestId: string, member: string, path: string, writer: Writer, app?: string): Promise<TransferFinish> {
    filePath(path, app);
    const session = await this.createSession({ id: requestId, member, capability: 'download' });
    const connection = await this.connectSession(session), hash = createHash('sha256');
    try {
      await connection.sendControl({ type: 'begin', path, ...(app === undefined ? {} : { app }) });
      const meta = checked(await connection.receive(), requestId);
      if (!record(meta) || Object.keys(meta).sort().join(',') !== 'size,type' || meta.type !== 'begin') throw new Error('metadata');
      const size = length(meta.size); let remaining = size;
      while (remaining) {
        const data = checked(await connection.receive(), requestId);
        if (!Buffer.isBuffer(data) || !data.length || data.length > Math.min(65536, remaining)) throw new Error('incomplete');
        hash.update(data); remaining -= data.length; let offset = 0;
        while (offset < data.length) {
          const n = await writer.write(data.subarray(offset));
          if (!Number.isSafeInteger(n) || n <= 0 || n > data.length - offset) throw new Error('writer');
          offset += n;
        }
      }
      const result = checked(await connection.receive(), requestId);
      if (!finish(result, size, hash.digest('hex'))) throw new Error('digest');
      return result;
    } catch (error) { throw interrupted(error, requestId); } finally { connection.close(); }
  }
  async accessibility(requestId: string, member = 'primary', maxSnapshotBytes = MAX_SNAPSHOT_BYTES) {
    if (!Number.isInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > MAX_SNAPSHOT_BYTES) throw new ConsumerConfigurationError('Choose an accessibility budget within 6 MiB.');
    const session = await this.createSession({ id: requestId, member, capability: 'accessibility' });
    const connection = await this.connectSession(session);
    try { return await receiveSnapshot(connection, requestId, maxSnapshotBytes); }
    catch (error) { throw interrupted(error, requestId); } finally { connection.close(); }
  }
  async downloadToFile(requestId: string, member: string, path: string, destination: string, options: { app?: string; replace?: boolean; files?: DownloadFiles; helperPath?: string } = {}): Promise<TransferFinish> {
    identifier(requestId);
    if (options.files !== undefined && options.helperPath !== undefined) throw new ConsumerConfigurationError('Choose an injected file adapter or a configured helper path.');
    if (options.helperPath !== undefined && !isAbsolute(options.helperPath)) throw new ConsumerConfigurationError('Use an absolute filesystem-helper path.');
    const files = options.files ?? scopedDownloadFiles(options.helperPath === undefined ? {} : { helperPath: options.helperPath });
    return receiveFile(destination, writer => this.download(requestId, member, path, writer, options.app), options.replace ?? false, requestId, files);
  }
}
function filePath(path: string, app?: string): void {
  if (!validText(path) || !path.length || path.length > 4096 || (app !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.]*(?:\/[A-Za-z0-9_.$]+)?(?![\s\S])/.test(app))) throw new ConsumerConfigurationError('Invalid guest path or app.');
}
function finish(value: unknown, size: number, digest: string): value is TransferFinish {
  return record(value) && value.type === 'finish' && value.bytes === size && value.sha256 === digest;
}
/** Verified staged publication through a bound directory adapter. Platform bridges
 * retain directory/stage ownership through publication and cleanup. Inject `files`
 * for an external implementation with equivalent guarantees. Never retries a publish.
 */
export async function receiveFile(destination: string, transfer: (writer: Writer) => Promise<TransferFinish>, replace = false, requestId?: string, files: DownloadFiles = scopedDownloadFiles()): Promise<TransferFinish> {
  if (typeof replace !== 'boolean' || !validText(destination) || !destination || ['.', '..', ''].includes(basename(destination))) throw new ConsumerConfigurationError('Choose a destination filename and explicit replacement policy.');
  const requested = resolve(destination), name = basename(requested); let temporary: string | undefined, stage = 'prepare', directory: DownloadDirectory | undefined, temporaryUnknown = false;
  try {
    directory = await files.openDirectory(dirname(requested));
    if (!replace && await directory.exists(name)) throw new SessionError('Download destination already exists.', 'download_destination_exists', requestId, false);
    const candidate = '.canaveral-download-' + randomBytes(16).toString('hex');
    stage = 'create'; const output = await directory.createExclusive(candidate); temporary = candidate; stage = 'receive';
    let result: TransferFinish;
    try { result = await transfer({ write: data => output.write(data) }); await output.sync(); }
    finally { await output.close(); }
    stage = 'publish';
    const publication = await directory.publishOwned(temporary, name, replace);
    if (publication === 'exists') { stage = 'destination-exists'; throw new SessionError('Download destination appeared before publication.', 'download_destination_exists', requestId, false); }
    if (publication !== 'published') throw new Error('Unconfirmed publication result');
    stage = 'directory-sync';
    await directory.removeOwned(temporary); temporary = undefined;
    await directory.sync();
    return result;
  } catch (error) {
    if (error instanceof ConsumerError && stage !== 'publish' && stage !== 'directory-sync') {
      if (stage === 'receive') throw new SessionError('Download did not complete verified local publication; the destination was not replaced.', error.code, error.requestId ?? requestId, error.outcome === 'unknown', 'status' in error && typeof error.status === 'number' ? error.status : 409);
      throw error;
    }
    if (error instanceof FilePublicationError && error.reason === 'unavailable') throw new SessionError(error.message, 'capability_unsupported', requestId, false);
    if ((stage === 'create' && error !== null && typeof error === 'object' && 'outcome' in error && error.outcome === 'unknown') ||
        (error instanceof FilePublicationError && error.reason === 'temporary_unknown')) { temporaryUnknown = true; throw new SessionError('Private temporary creation or cleanup needs inspection.', 'download_temporary_cleanup_failed', requestId, true); }
    const uncertain = stage === 'publish' || stage === 'directory-sync';
    throw new SessionError(uncertain ? 'Download publication is uncertain. Inspect the local destination.' : 'Download failed before publication; the destination was not replaced.', uncertain ? 'download_publication_uncertain' : 'download_destination_failed', requestId, uncertain);
  } finally {
    try { if (temporary !== undefined) await directory!.removeOwned(temporary); }
    catch { throw new SessionError('Temporary cleanup needs inspection.', stage === 'publish' || stage === 'directory-sync' ? 'download_publication_uncertain' : 'download_temporary_cleanup_failed', requestId, temporaryUnknown || stage === 'publish' || stage === 'directory-sync'); }
    finally {
      try { await directory?.close(); }
      catch { throw new SessionError('Download file handle release needs inspection.', stage === 'publish' || stage === 'directory-sync' ? 'download_publication_uncertain' : 'download_temporary_cleanup_failed', requestId, temporaryUnknown || stage === 'publish' || stage === 'directory-sync'); }
    }
  }
}
