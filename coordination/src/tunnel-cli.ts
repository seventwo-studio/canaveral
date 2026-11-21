/** `canaveral tunnel`: holds one lease port tunnel open in the foreground, for example beside a
 * Metro bundler. The lease key comes from a private file (`--token-file`), never from argv.
 * Nothing is retried: when the tunnel ends, the command exits and names the reason. */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { CliError, credential, expandPath, option, positional, uuid } from "./account-cli.ts";
import type { CliArguments } from "./account-cli.ts";
import { ConsumerError } from "./consumer-client.ts";
import { LeaseTunnelClient } from "./tunnel-sdk.ts";
import type { LeaseTunnel, TunnelRequest } from "./tunnel-sdk.ts";
import { TUNNEL_IDLE_SECONDS_MAX, TUNNEL_IDLE_SECONDS_MIN, tunnelIntent } from "./tunnel-relay.ts";

export interface TunnelCliIO { stdout(text: string): void; stderr(text: string): void }
function integer(text: string, label: string, minimum: number, maximum: number): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new CliError(`Invalid ${label}.`);
  return value;
}
/** `HOST:PORT`, `[IPv6]:PORT` or, where a port alone is enough, `PORT`. */
function endpoint(text: string, label: string, minimum: number, portOnly: boolean): { host?: string; port: number } {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:\s]+)):(\d+)$/.exec(text);
  if (match) return { host: match[1] ?? match[2]!, port: integer(match[3]!, label + " port", minimum, 65535) };
  if (portOnly && /^\d+$/.test(text)) return { port: integer(text, label + " port", minimum, 65535) };
  throw new CliError(`Use ${portOnly ? "[HOST:]PORT" : "HOST:PORT"} for ${label}.`);
}
/** Controller refusals by stable code, in words an operator or agent can act on. */
const REFUSALS: Record<string, string> = {
  tunnels_not_permitted: "This application's policy allows no lease tunnels (limits.tunnelsPerLease).",
  capability_unsupported: "The lease's host does not offer lease tunnels (leaseTunnelProtocol), or the member is not an Android emulator.",
  member_not_ready: "The lease's device is not ready.",
  lease_ended: "The lease has ended.",
  tunnel_limit: "The lease already holds its maximum number of tunnels.",
  tunnel_host_limit: "The device host already holds its maximum number of tunnels.",
  tunnel_port_busy: "Another tunnel of this lease holds that device port, or its mapping is not yet confirmed removed.",
  tunnel_mapping_failed: "The device port mapping could not be created; the device port may be in use.",
  tunnel_ended: "This tunnel UUID was already used. Open a new tunnel with a new --request-id.",
  tunnel_listen_failed: "The local listener could not be bound.",
  unauthenticated: "The lease key was refused. Only the lease's current key opens a tunnel.",
};
function explain(error: ConsumerError): CliError {
  // Local configuration errors name no secret and say exactly what to change.
  if (error.name === "ConsumerConfigurationError") return new CliError(error.message);
  const status = "status" in error && typeof error.status === "number" ? error.status : 409;
  return new CliError((REFUSALS[error.code] ?? `Tunnel refused or interrupted (${error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}).`) + (error.outcome === "unknown" ? " Inspect the tunnel before opening another." : ""),
    status, error.requestId, error.outcome);
}

/** Opens the tunnel, prints one JSON line once the device mapping is installed, and holds it
 * until `signal` aborts (exit 0, tunnel closed) or the tunnel ends on its own (exit 1). */
export async function runTunnel(args: CliArguments, io: TunnelCliIO, signal: AbortSignal): Promise<number> {
  const leaseId = uuid(positional(args)), direction = positional(args, 1);
  if (direction !== "reverse" && direction !== "forward") throw new CliError("Tunnel direction must be reverse (device to this machine) or forward (this machine to the device).");
  const devicePort = integer(option(args, "device-port"), "--device-port", 1, 65535);
  const idleSeconds = args.options["idle-seconds"] === undefined ? undefined : integer(option(args, "idle-seconds"), "--idle-seconds", TUNNEL_IDLE_SECONDS_MIN, TUNNEL_IDLE_SECONDS_MAX);
  if (!tunnelIntent(direction, devicePort, idleSeconds)) throw new CliError("Reverse tunnels use device ports 1024-65535 and forward tunnels 1-65535; 5555 is reserved.");
  if (direction === "reverse" ? args.options.listen !== undefined : args.options.target !== undefined) throw new CliError("Use --target with reverse and --listen with forward.");
  const member = args.options.member === undefined ? "primary" : option(args, "member");
  let id: string;
  if (args.options["request-id"] === undefined) { id = randomUUID(); io.stderr(`Tunnel UUID ${id}\n`); } else id = uuid(option(args, "request-id"));
  const identity = { id, member, devicePort, ...(idleSeconds === undefined ? {} : { idleSeconds }) };
  // Both defaults stay on this machine's loopback, on the same port number as the device port.
  const request: TunnelRequest = direction === "reverse"
    ? { ...identity, direction, target: args.options.target === undefined ? { host: "127.0.0.1", port: devicePort } : endpoint(option(args, "target"), "--target", 1, false) as { host: string; port: number } }
    : { ...identity, direction, listen: args.options.listen === undefined ? { host: "127.0.0.1", port: devicePort } : endpoint(option(args, "listen"), "--listen", 0, true) };
  if (request.direction === "forward" && request.listen?.host !== undefined && !isIP(request.listen.host)) throw new CliError("--listen takes an IP literal; the default is 127.0.0.1.");
  let client: LeaseTunnelClient, tunnel: LeaseTunnel;
  try {
    client = new LeaseTunnelClient({ baseUrl: args.url, leaseId, leaseKey: await credential(args), allowLoopbackHttp: args.allowHttp,
      ...(args.options["ca-file"] === undefined ? {} : { caFile: resolve(expandPath(option(args, "ca-file"))) }) });
    tunnel = await client.open(request, { signal });
  } catch (error) { if (error instanceof ConsumerError) throw explain(error); throw error; }
  io.stdout(JSON.stringify({ tunnel: tunnel.id, leaseId, member, direction, devicePort, [direction === "reverse" ? "target" : "listening"]: `${tunnel.local.host.includes(":") ? `[${tunnel.local.host}]` : tunnel.local.host}:${tunnel.local.port}`, state: "open" }) + "\n");
  const end = await tunnel.closed;
  if (end.reason === "closed") { io.stdout(JSON.stringify({ tunnel: tunnel.id, state: end.state ?? "closed", connections: tunnel.stats.opened }) + "\n"); return 0; }
  const reasons: Record<string, string> = { expired: "the lease or its attach window expired", revoked: "the lease ended or its key was rotated", closed: "the tunnel was closed", disconnected: "the device, its host or the relay disconnected" };
  io.stderr(`canaveral: Tunnel ended: ${end.state ? reasons[end.state] ?? end.state : end.code ? REFUSALS[end.code] ?? end.reason : end.reason}. Nothing is retried; open a new tunnel with a new UUID if the lease is still ready.\n`);
  return 1;
}
