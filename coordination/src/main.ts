import { readFileSync, realpathSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { identifier } from "./consumers.ts";
import { secret } from "./errors.ts";
import { createIdentityHandler, limitServer } from "./http.ts";
import { IdentityClient } from "./identity-client.ts";

/** Explicit controller configuration. Nothing is discovered, adopted or defaulted to live state. */
export interface ControllerConfig {
  statePath: string;
  adminTokenFile: string;
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

export function parseControllerConfig(value: unknown): ControllerConfig {
  const input = record(value, ["statePath", "adminTokenFile", "controllerId", "listen"], ["tls"]);
  const listen = record(input.listen, ["host", "port"]);
  if (typeof listen.host !== "string" || !isIP(listen.host)) fail("listen.host must be an IP literal");
  if (typeof listen.port !== "number" || !Number.isSafeInteger(listen.port) || listen.port < 0 || listen.port > 65535) fail("listen.port must be 0-65535");
  let controllerId: string;
  try { controllerId = identifier(input.controllerId); } catch { fail("controllerId must be a UUID"); }
  const config: ControllerConfig = {
    statePath: path(input.statePath, "statePath"), adminTokenFile: path(input.adminTokenFile, "adminTokenFile"),
    controllerId, listen: { host: listen.host, port: listen.port },
  };
  if (input.tls !== undefined) {
    const tls = record(input.tls, ["certFile", "keyFile"]);
    config.tls = { certFile: path(tls.certFile, "tls.certFile"), keyFile: path(tls.keyFile, "tls.keyFile") };
  } else if (!loopback(config.listen.host)) fail("plain HTTP is limited to loopback; configure tls for any other address");
  return config;
}

/** Start one controller process: one owned SQLite worker and one listener. */
export async function startController(config: ControllerConfig) {
  const adminToken = secret(readFileSync(config.adminTokenFile, "utf8").replace(/\r?\n$/, ""));
  const client = new IdentityClient({ path: config.statePath, adminToken, controllerId: config.controllerId });
  await client.ready;
  const handler = createIdentityHandler(client);
  const server = limitServer(config.tls
    ? createHttpsServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile), minVersion: "TLSv1.2" }, handler)
    : createHttpServer(handler));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listen.port, config.listen.host, resolve); });
  const address = server.address() as AddressInfo;
  return {
    address,
    async close(): Promise<void> {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await client.close();
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
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Controller failed to start."}\n`);
    process.exit(1);
  }
}
