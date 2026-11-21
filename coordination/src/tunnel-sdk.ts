/** Lease port tunnels for the lease holder (docs/mobile-control.md, "Lease port tunnels").
 *
 * A reverse tunnel lets an app on the leased device reach one target the holder names on the
 * holder's own machine, for example a Metro bundler. A forward tunnel lets the holder reach one
 * port on the device through a local listener, bound to loopback unless the holder says
 * otherwise. Traffic is relayed through the controller; the holder needs no route to the device
 * host, and the device never selects a destination.
 *
 * Only the lease's current key opens a tunnel. Nothing here retries: an open whose outcome is
 * unknown is reported as such, and the caller inspects or deliberately replays the same UUID.
 * A tunnel identity is used once; after it ends, open a new tunnel with a new UUID. */
import { connect, createServer, isIP } from 'node:net';
import type { Server, Socket } from 'node:net';
import { ConsumerConfigurationError, ConsumerProtocolError, Transport } from './consumer-client.ts';
import type { LeaseClientOptions } from './consumer-client.ts';
import { checked, identifier, interrupted, record, SessionConnection, SessionError, timeout } from './sdk.ts';
import { TunnelRelay, tunnelIntent } from './tunnel-relay.ts';
import type { TunnelDirection, TunnelEnd, TunnelStats } from './tunnel-relay.ts';
export type { TunnelDirection, TunnelStats } from './tunnel-relay.ts';

export interface Tunnel {
  id: string; leaseId: string; member: string; direction: TunnelDirection; devicePort: number; idleSeconds: number;
  generation: string; capability: 'tunnel'; protocol: 'canaveral-session-v1';
  /** `pending`, `attaching` and `ready` are live; `closed`, `expired`, `revoked` and `disconnected` are final. */
  state: string; createdAt: string; attachBefore: string; authorizationDeadline: string;
  /** The device mapping is known to be gone; the tunnel no longer holds its device port. */
  mappingRemoved: boolean;
  /** Set when the runner itself ended the tunnel: `mapping_failed`, `mapping_lost` or `open_rate`. */
  endReason?: string;
  limits: { connections: number; windowBytes: number };
}
/** Where a reverse tunnel's connections go on the holder's machine. Default host: 127.0.0.1. */
export interface TunnelTarget { host?: string; port: number }
/** Where a forward tunnel listens on the holder's machine. Defaults: 127.0.0.1 and an ephemeral port. */
export interface TunnelListen { host?: string; port?: number }
export interface TunnelIdentity { id: string; member: string; devicePort: number; idleSeconds?: number }
export type TunnelRequest = (TunnelIdentity & { direction: 'reverse'; target: TunnelTarget }) | (TunnelIdentity & { direction: 'forward'; listen?: TunnelListen });
export type TunnelBinding = { target: TunnelTarget } | { listen?: TunnelListen };
export interface TunnelOpenOptions { timeoutMs?: number; signal?: AbortSignal }
/** Why an open tunnel ended. `state` and `endReason` are the controller's record when it could
 * still be read: `endReason` names what the runner found (`mapping_lost`, `open_rate`). */
export interface TunnelClosed { reason: TunnelEnd['reason']; code?: string; state?: string; endReason?: string }

const STATES = ['pending', 'attaching', 'ready', 'closed', 'expired', 'revoked', 'disconnected'];
function port(value: unknown, minimum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 65535) throw new ConsumerConfigurationError(`Invalid ${label}.`);
  return value;
}
function target(value: unknown): { host: string; port: number } {
  if (!record(value) || Object.keys(value).some(k => !['host', 'port'].includes(k))) throw new ConsumerConfigurationError('A reverse tunnel needs an explicit target {host?, port}.');
  const host = value.host === undefined ? '127.0.0.1' : value.host;
  // One named endpoint: an IP literal or a host name. No wildcard and no per-connection choice.
  if (typeof host !== 'string' || !host || host.length > 253 || !(isIP(host) || /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/.test(host))) throw new ConsumerConfigurationError('Invalid tunnel target host.');
  return { host, port: port(value.port, 1, 'tunnel target port') };
}
function listen(value: unknown): { host: string; port: number } {
  const input = value === undefined ? {} : value;
  if (!record(input) || Object.keys(input).some(k => !['host', 'port'].includes(k))) throw new ConsumerConfigurationError('Invalid forward tunnel listener {host?, port?}.');
  const host = input.host === undefined ? '127.0.0.1' : input.host;
  if (typeof host !== 'string' || !isIP(host)) throw new ConsumerConfigurationError('A forward tunnel listens on an IP literal; the default is 127.0.0.1.');
  return { host, port: input.port === undefined ? 0 : port(input.port, 0, 'tunnel listener port') };
}
function view(value: unknown): Tunnel {
  if (!record(value) || typeof value.member !== 'string' || !value.member || !tunnelIntent(value.direction, value.devicePort, value.idleSeconds) || value.capability !== 'tunnel' ||
      value.protocol !== 'canaveral-session-v1' || !STATES.includes(String(value.state)) || typeof value.mappingRemoved !== 'boolean' ||
      !record(value.limits) || !Number.isSafeInteger(value.limits.connections) || !Number.isSafeInteger(value.limits.windowBytes)) throw new Error('tunnel');
  identifier(value.id); identifier(value.leaseId); identifier(value.generation);
  return value as unknown as Tunnel;
}

/** One open tunnel. It stays open until `close()`, until the lease ends or its key is rotated,
 * or until either peer disconnects. `closed` resolves once and never rejects. */
export class LeaseTunnel {
  readonly closed: Promise<TunnelClosed>;
  #relay: TunnelRelay;
  #close: () => Promise<void>;
  /** @internal */
  constructor(readonly tunnel: Tunnel, readonly local: { host: string; port: number }, relay: TunnelRelay, closed: Promise<TunnelClosed>, close: () => Promise<void>) {
    this.#relay = relay; this.closed = closed; this.#close = close;
  }
  get id(): string { return this.tunnel.id; }
  get direction(): TunnelDirection { return this.tunnel.direction; }
  get devicePort(): number { return this.tunnel.devicePort; }
  /** Connections opened, currently active and refused at the limit, and bytes each way. */
  get stats(): TunnelStats { return { ...this.#relay.stats }; }
  /** Closes the tunnel and every connection on it. The runner then removes the device mapping. */
  async close(): Promise<TunnelClosed> { await this.#close(); return this.closed; }
}

export class LeaseTunnelClient {
  readonly leaseId: string;
  readonly transport: Transport;
  constructor(options: LeaseClientOptions) { this.transport = new Transport(options, options.leaseKey); this.leaseId = identifier(options.leaseId); }
  async #call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, id: string, accepted = [200]): Promise<{ status: number; tunnel: Tunnel }> {
    const { status, json } = await this.transport.call(method, path, body, accepted, method === 'POST', method === 'POST' ? id : undefined);
    try {
      const tunnel = view(json);
      if (tunnel.id !== id || tunnel.leaseId !== this.leaseId) throw new Error('identity');
      return { status, tunnel };
    } catch { throw new ConsumerProtocolError('Invalid tunnel receipt.', 'response_invalid', status, { requestId: id, ...(method === 'POST' ? { outcome: 'unknown' as const } : {}) }); }
  }
  /** Creates the tunnel, or returns the saved one for a replayed UUID. Persist `id` first. The
   * controller sees the device port and direction only, never the holder-side target. */
  async create(request: TunnelIdentity & { direction: TunnelDirection }): Promise<{ created: boolean; tunnel: Tunnel }> {
    const id = identifier(request.id), intent = tunnelIntent(request.direction, request.devicePort, request.idleSeconds);
    if (!intent || typeof request.member !== 'string' || !request.member.trim() || [...request.member].length > 100) throw new ConsumerConfigurationError('Invalid tunnel request: reverse device ports are 1024-65535, forward 1-65535, never 5555; idleSeconds is 10-3600.');
    const { status, tunnel } = await this.#call('POST', `/v1/leases/${this.leaseId}/tunnels`, { id, member: request.member, direction: intent.direction, devicePort: intent.devicePort, ...(request.idleSeconds === undefined ? {} : { idleSeconds: intent.idleSeconds }) }, id, [200, 201]);
    if (tunnel.member !== request.member || tunnel.direction !== intent.direction || tunnel.devicePort !== intent.devicePort || tunnel.idleSeconds !== intent.idleSeconds) throw new ConsumerProtocolError('Tunnel receipt differs from its request.', 'response_invalid', status, { requestId: id, outcome: 'unknown' });
    return { created: status === 201, tunnel };
  }
  async inspect(tunnelId: string): Promise<Tunnel> { const id = identifier(tunnelId); return (await this.#call('GET', `/v1/leases/${this.leaseId}/tunnels/${id}`, undefined, id)).tunnel; }
  /** Ends the tunnel; safe to repeat. The runner then removes the device mapping. */
  async close(tunnelId: string): Promise<Tunnel> { const id = identifier(tunnelId); return (await this.#call('POST', `/v1/leases/${this.leaseId}/tunnels/${id}/close`, {}, id)).tunnel; }
  async list(): Promise<Tunnel[]> {
    const { status, json } = await this.transport.call('GET', `/v1/leases/${this.leaseId}/tunnels`, undefined, [200], false);
    try {
      if (!record(json) || !Array.isArray(json.tunnels)) throw new Error('list');
      return json.tunnels.map(item => { const tunnel = view(item); if (tunnel.leaseId !== this.leaseId) throw new Error('lease'); return tunnel; });
    } catch { throw new ConsumerProtocolError('Invalid tunnel list.', 'response_invalid', status, {}); }
  }
  /** Creates (or replays) the tunnel and holds it open. Resolves once the runner has installed
   * the device mapping; a reverse target or forward listener is fixed for the tunnel's lifetime. */
  async open(request: TunnelRequest, options: TunnelOpenOptions = {}): Promise<LeaseTunnel> {
    if (!record(request)) throw new ConsumerConfigurationError('Invalid tunnel request.');
    const { target: named, listen: listener, ...identity } = request as TunnelIdentity & { direction: TunnelDirection; target?: unknown; listen?: unknown };
    if (Object.keys(identity).some(k => !['id', 'member', 'direction', 'devicePort', 'idleSeconds'].includes(k)) || identity.direction === 'reverse' && (named === undefined || listener !== undefined) || identity.direction === 'forward' && named !== undefined) throw new ConsumerConfigurationError('A reverse tunnel names a target; a forward tunnel may name a listener.');
    // Validate the holder-side endpoint before anything is created on the controller.
    const binding: TunnelBinding = identity.direction === 'reverse' ? { target: target(named) } : { listen: listen(listener) };
    timeout(options.timeoutMs ?? 30_000);
    const { tunnel } = await this.create(identity);
    return this.connect(tunnel, binding, options);
  }
  /** Attaches to a created tunnel. A tunnel is attached once; after it ends, open a new one. */
  async connect(tunnel: Tunnel, binding: TunnelBinding, options: TunnelOpenOptions = {}): Promise<LeaseTunnel> {
    const wait = timeout(options.timeoutMs ?? 30_000);
    let current: Tunnel;
    try { current = view(tunnel); if (current.leaseId !== this.leaseId) throw new Error('lease'); } catch { throw new ConsumerConfigurationError('Tunnel must belong to this lease.'); }
    const local = current.direction === 'reverse' ? target((binding as { target?: unknown }).target) : listen((binding as { listen?: unknown }).listen);
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new ConsumerConfigurationError('signal must be an AbortSignal.');
    if (options.signal?.aborted) throw new SessionError('Tunnel was cancelled before attachment.', 'tunnel_cancelled', current.id, false);
    if (!['pending', 'attaching'].includes(current.state)) throw new SessionError(`Tunnel is ${current.state}. A tunnel identity is used once; open a new tunnel with a new UUID.`, 'tunnel_ended', current.id, false, 410);
    let connection: SessionConnection;
    try { connection = await SessionConnection.connect(this.transport, `/v1/leases/${this.leaseId}/tunnels/${current.id}/${current.generation}`, current.id); }
    catch (error) { throw interrupted(error, current.id); }
    let server: Server | undefined;
    try {
      const ready = checked(await connection.receive(wait), current.id);
      if (!record(ready) || ready.type !== 'ready' || ready.sessionId !== current.id || ready.generation !== current.generation || ready.capability !== 'tunnel') throw new SessionError('Tunnel peers did not become ready. Inspect the tunnel before opening another.', 'session_incomplete', current.id);
      // The runner sends this only after the device mapping is installed and verified.
      const installed = checked(await connection.receive(wait), current.id);
      if (!record(installed) || Object.keys(installed).sort().join(',') !== 'devicePort,direction,type' || installed.type !== 'tunnel' || installed.direction !== current.direction || installed.devicePort !== current.devicePort) throw new SessionError('The device port mapping was not confirmed. Inspect the tunnel before opening another.', 'session_incomplete', current.id);
      const relay = new TunnelRelay({ sendControl: value => connection.sendControl(value), sendBytes: value => connection.sendBytes(value), receive: () => connection.receive(30_000), close: () => connection.close() },
        { role: current.direction === 'reverse' ? 'connect' : 'listen', idleSeconds: current.idleSeconds, ...(current.direction === 'reverse' ? { connect: () => dial(local) } : {}) });
      const ended = relay.run();
      if (current.direction === 'forward') {
        const listening = server = createServer({ allowHalfOpen: true }, socket => relay.accept(socket));
        listening.on('error', () => {});
        try { await new Promise<void>((resolve, reject) => { listening.once('error', reject); listening.listen({ host: local.host, port: local.port, exclusive: true }, () => { listening.removeListener('error', reject); resolve(); }); }); }
        catch { relay.close(); await ended; throw new SessionError('The local tunnel listener could not be bound; the tunnel was closed.', 'tunnel_listen_failed', current.id, false); }
        const address = listening.address();
        if (address && typeof address !== 'string') local.port = address.port;
      }
      let requested: Promise<void> | undefined;
      const close = (): Promise<void> => requested ??= (async () => {
        // Closing through the controller records `closed`; the socket then ends the relay.
        try { await this.close(current.id); } catch { /* The relay still ends locally; the lease bounds the tunnel. */ }
        relay.close();
      })();
      const abort = (): void => { void close(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      const closed = ended.then(async end => {
        options.signal?.removeEventListener('abort', abort);
        if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); });
        let saved: Tunnel | undefined;
        try { saved = await this.inspect(current.id); } catch { /* A rotated key or lost controller leaves the reason as reported. */ }
        // A close this holder asked for is reported as such, whichever side's socket ended first.
        return { ...(requested ? { reason: 'closed' as const } : end), ...(saved ? { state: saved.state } : {}), ...(saved?.endReason ? { endReason: saved.endReason } : {}) };
      });
      if (options.signal?.aborted) abort();
      return new LeaseTunnel(current, local, relay, closed, close);
    } catch (error) {
      connection.close();
      if (server) server.close();
      // The tunnel is not reused: end it so its device mapping and slot are released.
      try { await this.close(current.id); } catch { /* It also ends with its attach deadline or lease. */ }
      throw error instanceof SessionError && error.code === 'tunnel_listen_failed' ? error : interrupted(error, current.id);
    }
  }
}
function dial(endpoint: { host: string; port: number }): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true });
    socket.once('error', reject);
    socket.once('connect', () => { socket.removeListener('error', reject); socket.on('error', () => {}); resolve(socket); });
  });
}
