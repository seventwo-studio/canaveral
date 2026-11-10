import { readFileSync, realpathSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { identifier } from "./consumers.ts";
import { secret } from "./errors.ts";
import { limitServer } from "./http.ts";
import { IdentityClient } from "./identity-client.ts";
import { ControlClient } from "./control/client.ts";
import { createControllerHandler, createControllerUpgradeHandler } from "./control/http.ts";
import { createSessionUpgradeHandler } from "./control/sessions.ts";

/** Explicit controller configuration. Nothing is discovered, adopted or defaulted to live state. */
export interface ControllerConfig {
  statePath: string;
  adminTokenFile: string;
  enrollmentTokenFile?: string;
  updatePublicKeys?: Record<string, string>;
  controllerId: string;
  listen: { host: string; port: number };
  tls?: { certFile: string; keyFile: string };
}

function fail(message: string): never { throw new Error(`Invalid controller configuration: ${message}`); }
function record(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const input = value as Record<string, unknown>;
  if (fields.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => ![...fields, ...optional].includes(key))) fail("unexpected or missing fields");
  return input;
}
function path(value: unknown, what: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) fail(`${what} must be an absolute path`);
  return value;
}
function loopback(host: string): boolean {
  return (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
}

export function parseUpdatePublicKeys(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("updatePublicKeys must be a public key map");
  const entries = Object.entries(value);
  if (entries.length > 16) fail("at most 16 update trust keys are supported");
  return Object.fromEntries(entries.map(([id, pem]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || typeof pem !== "string" || pem.length > 16384 || !pem.trim().startsWith("-----BEGIN PUBLIC KEY-----")) fail("invalid update trust key");
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") fail("update trust keys must use Ed25519");
      return [id, key.export({ type: "spki", format: "pem" }).toString()];
    } catch { return fail("invalid Ed25519 update public key"); }
  }));
}

export function parseControllerConfig(value: unknown): ControllerConfig {
  const input = record(value, ["statePath", "adminTokenFile", "controllerId", "listen"], ["tls", "enrollmentTokenFile", "updatePublicKeys"]);
  const listen = record(input.listen, ["host", "port"]);
  if (typeof listen.host !== "string" || !isIP(listen.host)) fail("listen.host must be an IP literal");
  if (typeof listen.port !== "number" || !Number.isSafeInteger(listen.port) || listen.port < 0 || listen.port > 65535) fail("listen.port must be 0-65535");
  let controllerId: string;
  try { controllerId = identifier(input.controllerId); } catch { fail("controllerId must be a UUID"); }
  const config: ControllerConfig = {
    statePath: path(input.statePath, "statePath"), adminTokenFile: path(input.adminTokenFile, "adminTokenFile"),
    controllerId, listen: { host: listen.host, port: listen.port },
  };
  if (input.enrollmentTokenFile !== undefined) config.enrollmentTokenFile = path(input.enrollmentTokenFile, "enrollmentTokenFile");
  if (input.updatePublicKeys !== undefined) config.updatePublicKeys = parseUpdatePublicKeys(input.updatePublicKeys);
  if (input.tls !== undefined) {
    const tls = record(input.tls, ["certFile", "keyFile"]);
    config.tls = { certFile: path(tls.certFile, "tls.certFile"), keyFile: path(tls.keyFile, "tls.keyFile") };
  } else if (!loopback(config.listen.host)) fail("plain HTTP is limited to loopback; configure tls for any other address");
  return config;
}

/** Start explicit identity and control workers on the same database and listener. */
export async function startController(config: ControllerConfig) {
  config = parseControllerConfig(config);
  const adminToken = secret(readFileSync(config.adminTokenFile, "utf8").replace(/\r?\n$/, ""));
  const enrollmentToken = config.enrollmentTokenFile === undefined ? undefined
    : secret(readFileSync(config.enrollmentTokenFile, "utf8").replace(/\r?\n$/, ""));
  if (adminToken === enrollmentToken) fail("admin and enrollment credentials must differ");
  const tls = config.tls ? { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile), minVersion: "TLSv1.2" as const } : undefined;
  const client = new IdentityClient({ path: config.statePath, adminToken, controllerId: config.controllerId });
  let control: ControlClient | undefined;
  let server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer> | undefined;
  let broker: ReturnType<typeof createSessionUpgradeHandler> | undefined;
  try {
    await client.ready;
    control = new ControlClient({ path: config.statePath, adminToken, controllerId: config.controllerId,
      ...(enrollmentToken === undefined ? {} : { enrollmentToken }),
      ...(config.updatePublicKeys === undefined ? {} : { updatePublicKeys: config.updatePublicKeys }) });
    await control.ready;
    const handler = createControllerHandler(control, client);
    server = limitServer(tls ? createHttpsServer(tls, handler) : createHttpServer(handler));
    server.on("checkContinue", handler);
    server.on("checkExpectation", handler);
    broker = createSessionUpgradeHandler(control);
    server.on("upgrade", createControllerUpgradeHandler(broker.handle));
    await new Promise<void>((resolve, reject) => {
      const listening = () => { server!.off("error", reject); resolve(); };
      server!.once("error", reject); server!.listen(config.listen.port, config.listen.host, listening);
    });
  } catch (error) {
    broker?.close();
    server?.close();
    await Promise.allSettled([client.close(), control?.close()]);
    throw error;
  }
  const listener = server;
  const services = control;
  const address = listener.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    address,
    async close(): Promise<void> {
      closing ??= (async () => {
        broker?.close();
        await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
        await Promise.all([client.close(), services.close()]);
      })();
      await closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    process.stderr.write("usage: node dist/src/main.js /absolute/controller-config.json\n");
    process.exit(2);
  }
  try {
    const controller = await startController(parseControllerConfig(JSON.parse(readFileSync(file, "utf8")) as unknown));
    process.stdout.write(JSON.stringify({ listening: { host: controller.address.address, port: controller.address.port } }) + "\n");
    const stop = () => { void controller.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  } catch {
    process.stderr.write("Controller failed to start. Check explicit configuration, credentials and state compatibility.\n");
    process.exit(1);
  }
}
