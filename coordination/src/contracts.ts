import { existsSync, readFileSync } from "node:fs";

const artifacts = new Set(["consumer-api.openapi.json", "session-control.schema.json", "accessibility-snapshot.schema.json"]);

/** Read a fresh copy of a packaged contract without contacting the controller. */
export function contract(name: string): Record<string, unknown> {
  if (!artifacts.has(name)) throw new TypeError("Unknown packaged contract.");
  // The first location is for emitted JavaScript, the second for source execution.
  const locations = [new URL(`../../../canaveral/schemas/${name}`, import.meta.url), new URL(`../../canaveral/schemas/${name}`, import.meta.url)];
  const location = locations.find(candidate => existsSync(candidate));
  if (!location) throw new Error("Packaged contract is missing.");
  const result: unknown = JSON.parse(readFileSync(location, "utf8"));
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("Packaged contract is malformed.");
  return result as Record<string, unknown>;
}

export function consumerApiSchema(): Record<string, unknown> { return contract("consumer-api.openapi.json"); }
export function sessionProtocolSchema(): Record<string, unknown> { return contract("session-control.schema.json"); }
