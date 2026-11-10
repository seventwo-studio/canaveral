import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { identifier } from "../consumers.ts";
import type { Resources } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";

export function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > max) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}
export function integer(value: unknown, label: string, max = 1_048_576): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}
export function resources(value: unknown): Resources {
  const v = object(value);
  return { cpu: integer(v.cpu, "cpu"), memoryMiB: integer(v.memoryMiB, "memoryMiB"), diskGiB: integer(v.diskGiB, "diskGiB") };
}
/** Python digest compatibility: sorted keys, ASCII JSON and default separators. */
export function legacyJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyJson).join(", ")}]`;
  const v = object(value);
  return `{${Object.keys(v).sort((a, b) => {
    const x = Array.from(a), y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) { const n = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!; if (n) return n; }
    return x.length - y.length;
  }).map(k => `${legacyJson(k)}: ${legacyJson(v[k])}`).join(", ")}}`;
}
export const legacyDigest = (value: unknown): string => createHash("sha256").update(legacyJson(value)).digest("hex");
const only = (v: Record<string, unknown>, fields: string[]): void => {
  if (Object.keys(v).some(k => !fields.includes(k))) throw new ServiceError("Unknown configuration fields.", 400);
};
function full(pattern: RegExp, value: string): boolean { return pattern.exec(value)?.[0] === value; }
const defaulted = (v: Record<string, unknown>, key: string, fallback: unknown): unknown => Object.hasOwn(v, key) ? v[key] : fallback;
export interface PreparationRecipe {
  driver: "cloud-init" | "cloudbase-init" | "ssh";
  timeoutSeconds: number; packages: string[]; commands: string[]; sshAuthorizedKeys: string[];
  user?: string | null;
  files: { path: string; content: string; mode: string }[];
}
export function recipe(value: unknown, system: string): PreparationRecipe | null {
  return parseRecipe(value, system, false);
}
/** Private, operator-installed native bundles never travel in public template bodies. */
export function operatorRecipe(value: unknown, system: string): PreparationRecipe | null {
  return parseRecipe(value, system, true);
}
function parseRecipe(value: unknown, system: string, operatorBundle: boolean): PreparationRecipe | null {
  if (value === undefined || value === null) return null;
  const v = object(value);
  if (v.driver !== "cloud-init" && v.driver !== "cloudbase-init" && v.driver !== "ssh") throw new ServiceError("Preparation driver must be cloud-init, cloudbase-init or ssh.", 400);
  if ((v.driver === "cloud-init" && system !== "linux") || (v.driver === "cloudbase-init" && system !== "windows")) throw new ServiceError("Preparation driver is incompatible with this image OS.", 400);
  only(v, ["driver", "packages", "files", "commands", "user", "sshAuthorizedKeys", "timeoutSeconds"]);
  const strings = (key: string): string[] => {
    const values = defaulted(v, key, []);
    if (!Array.isArray(values) || values.length > 200) throw new ServiceError(`Invalid preparation ${key}.`, 400);
    return values.map(x => text(x, key, 16000));
  };
  const result: PreparationRecipe = { driver: v.driver, timeoutSeconds: integer(defaulted(v, "timeoutSeconds", 1800), "preparation timeout", 86400), packages: strings("packages"), commands: strings("commands"), sshAuthorizedKeys: strings("sshAuthorizedKeys"), files: [] };
  if (result.packages.length && system !== "linux") throw new ServiceError("Use native preparation commands for non-Linux package installation.", 400);
  if (result.packages.some(p => !full(/^[A-Za-z0-9][A-Za-z0-9+_.:@/-]*$/, p))) throw new ServiceError("Invalid Linux package name.", 400);
  if (v.user !== undefined) {
    if (v.user !== null && (system !== "linux" || typeof v.user !== "string" || !full(/^[a-z_][a-z0-9_-]{0,30}$/, v.user))) throw new ServiceError("Automatic user configuration requires a valid Linux username.", 400);
    result.user = v.user as string | null;
  }
  if (result.sshAuthorizedKeys.length && !result.user) throw new ServiceError("SSH keys require a configured Linux user.", 400);
  const files = defaulted(v, "files", []);
  if (!Array.isArray(files) || files.length > (operatorBundle ? 4096 : 100)) throw new ServiceError("Invalid preparation files.", 400);
  result.files = files.map(x => {
    const f = object(x); only(f, ["path", "content", "mode"]);
    const path = text(f.path, "guest file path", 1000);
    if (path.includes("\0") || (system === "windows" ? !/^[A-Za-z]:[\\/]/.test(path) : !path.startsWith("/")) || typeof f.content !== "string" || Array.from(f.content).length > (operatorBundle ? 1048576 : 65536)) throw new ServiceError("Invalid absolute guest file path/content.", 400);
    const mode = defaulted(f, "mode", "0600");
    if (typeof mode !== "string" || !full(/^0[0-7]{3}$/, mode)) throw new ServiceError("File mode must use four octal digits.", 400);
    return { path, content: f.content, mode };
  });
  if (legacyJson(result).length > (operatorBundle ? 128 * 1048576 : 200000)) throw new ServiceError("Preparation recipe is too large.", 400);
  return result;
}
export interface ImageSource { url?: string; path?: string; sha256: string; format: "raw" | "qcow2" | "vhdx" | "ipsw" | "iso" }
export function source(value: unknown): ImageSource {
  const v = object(value); only(v, ["url", "path", "sha256", "format"]);
  if (("url" in v) === ("path" in v) || !["raw", "qcow2", "vhdx", "ipsw", "iso"].includes(String(v.format)) || typeof v.sha256 !== "string" || !full(/^[a-f0-9]{64}$/, v.sha256)) throw new ServiceError("Image source requires exactly one URL/path, format and SHA-256 checksum.", 400);
  if ("url" in v) {
    if (typeof v.url !== "string" || v.url.length > 8000) throw new ServiceError("Invalid base image URL.", 400);
    let url: URL; try { url = new URL(v.url); } catch { throw new ServiceError("Invalid base image URL.", 400); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) throw new ServiceError("Base image URLs must use HTTPS without embedded credentials.", 400);
  } else if (typeof v.path !== "string" || !isAbsolute(v.path)) throw new ServiceError("Local base image paths must be absolute.", 400);
  return { ...v } as unknown as ImageSource;
}
export interface Template extends Record<string, unknown> {
  id: string; revision: string; os: "linux" | "windows" | "macos" | "android" | "ios";
  arch: "arm64" | "amd64"; mode: "headless" | "desktop" | "device";
  minimum: Resources; defaults: Resources; memoryStepMiB: number;
  recipeDigest?: string; preparationDriver?: "none" | PreparationRecipe["driver"];
}
/** Public, immutable definition. Private recipes and backend paths are stripped. */
export function normalizeTemplate(value: unknown): Template {
  return normalizeDefinition(value, false);
}
export function normalizeOperatorTemplate(value: unknown): Template {
  return normalizeDefinition(value, true);
}
function normalizeDefinition(value: unknown, operatorBundle: boolean): Template {
  const v = object(value);
  const os = text(v.os, "os"), arch = text(v.arch, "arch"), mode = text(v.mode, "mode");
  if (!["linux", "macos", "windows", "android", "ios"].includes(os) || !["arm64", "amd64"].includes(arch) || !["headless", "desktop", "device"].includes(mode) || (["android", "ios"].includes(os) !== (mode === "device"))) throw new ServiceError("Unsupported template operating system, architecture or mode.", 400);
  const minimum = resources(v.minimum), defaults = resources(defaulted(v, "defaults", minimum));
  if (defaults.cpu < minimum.cpu || defaults.memoryMiB < minimum.memoryMiB || defaults.diskGiB < minimum.diskGiB) throw new ServiceError("Template defaults cannot be smaller than its minimums.", 400);
  const result = { id: text(v.id, "id"), revision: text(v.revision, "revision"), os, arch, mode, minimum, defaults, memoryStepMiB: integer(defaulted(v, "memoryStepMiB", 1), "memory step") } as Template;
  if (defaults.memoryMiB % result.memoryStepMiB) throw new ServiceError("Default memory must match the template's memory granularity.", 400);
  if ("name" in v) result.name = text(v.name, "image name");
  if ("catalogueImageId" in v) {
    result.catalogueImageId = identifier(v.catalogueImageId);
    if (typeof v.artifactSha256 !== "string" || !full(/^[a-f0-9]{64}$/, v.artifactSha256)) throw new ServiceError("A catalogue image requires its artifact checksum.", 400);
    result.artifactSha256 = v.artifactSha256;
  }
  for (const [key, allowed] of [["mediaType", ["disk", "installer"]], ["imageKind", ["base", "derived"]], ["runtime", ["apple", "libvirt", "hyperv", "android", "ios", "kubevirt"]]] as const) {
    if (key in v) { if (!allowed.some(x => x === v[key])) throw new ServiceError(`Invalid ${key}.`, 400); result[key] = v[key]; }
  }
  if ("cloneIdentity" in v) { if (v.cloneIdentity !== "linux-cloud-init" || os !== "linux") throw new ServiceError("Unsupported clone identity provisioning.", 400); result.cloneIdentity = v.cloneIdentity; }
  if ("guestAccess" in v) { if (v.guestAccess !== true || os !== "linux") throw new ServiceError("Guest access is currently supported for Linux only.", 400); result.guestAccess = true; }
  if (mode === "device") {
    const d = object(v.device), keys = os === "android" ? ["systemImage", "profile"] : ["runtime", "deviceType"];
    only(d, keys); if (Object.keys(d).length !== 2) throw new ServiceError("Invalid device definition.", 400);
    const device: Record<string, string> = {};
    for (const key of keys) { const s = text(d[key], key, 200); if (!full(/^[A-Za-z0-9_.;:][A-Za-z0-9_.;:-]*$/, s)) throw new ServiceError("Invalid SDK runtime identifier.", 400); device[key] = s; }
    if (os === "android" ? !new RegExp(`^system-images;android-[0-9]+;[A-Za-z0-9_-]+;${arch === "arm64" ? "arm64-v8a" : "x86_64"}$`).test(device.systemImage!) : !device.runtime!.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") || !device.deviceType!.startsWith("com.apple.CoreSimulator.SimDeviceType.")) throw new ServiceError("Device runtime must match the OS and architecture.", 400);
    result.device = device;
    if (v.source || v.prepare || (v.preparationDriver ?? "none") !== "none") throw new ServiceError("Mobile devices use installed SDK runtimes without VM preparation.", 400);
  }
  if ("prepare" in v || "source" in v) {
    const prepared = (operatorBundle ? operatorRecipe : recipe)(v.prepare, os), base = "source" in v ? source(v.source) : null;
    result.recipeDigest = legacyDigest({ prepare: prepared, source: base ? { sha256: base.sha256, format: base.format } : null });
    result.preparationDriver = prepared?.driver ?? "none";
  } else if ("recipeDigest" in v) {
    if (typeof v.recipeDigest !== "string" || !full(/^[a-f0-9]{64}$/, v.recipeDigest) || !["none", "cloud-init", "cloudbase-init", "ssh"].includes(String(v.preparationDriver))) throw new ServiceError("Invalid public template contract.", 400);
    result.recipeDigest = v.recipeDigest; result.preparationDriver = v.preparationDriver as Template["preparationDriver"] & string;
  }
  return result;
}
export const HOST_RUNTIMES: Readonly<Record<string, readonly string[]>> = { macos: ["apple", "android", "ios"], linux: ["libvirt", "android"], windows: ["hyperv"] };
export function enabledRuntimes(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  let runtimes = config.runtimes;
  if (Array.isArray(runtimes)) {
    if (runtimes.some(x => typeof x !== "string") || new Set(runtimes).size !== runtimes.length) throw new ServiceError("Invalid runtime catalogue.", 400);
    runtimes = Object.fromEntries(runtimes.map(x => [x, {}]));
  }
  const r = object(runtimes), allowed = HOST_RUNTIMES[String(config.provider)];
  if (!allowed || !Object.keys(r).length || Object.entries(r).some(([k, v]) => !allowed.includes(k) || !v || typeof v !== "object" || Array.isArray(v))) throw new ServiceError("A physical host requires compatible configured runtimes.", 400);
  return r as Record<string, Record<string, unknown>>;
}
export function runtimeFor(config: Record<string, unknown>, image: Record<string, unknown>): string {
  const runtimes = enabledRuntimes(config);
  const name = image.runtime ?? (["android", "ios"].includes(String(image.os)) ? image.os : Object.keys(runtimes).find(k => ["apple", "libvirt", "hyperv"].includes(k)));
  const systems: Record<string, string[]> = { apple: ["linux", "macos"], libvirt: ["linux", "windows"], hyperv: ["linux", "windows"], android: ["android"], ios: ["ios"] };
  if (typeof name !== "string" || !Object.hasOwn(runtimes, name) || !systems[name]?.includes(String(image.os))) throw new ServiceError("Image requires a compatible runtime enabled on the host.", 400);
  return name;
}
/** Load references relative to the owner-selected config, preserving private bindings. No tools run. */
export function loadHostConfig(path: string): Record<string, unknown> & { templates: Record<string, unknown>[] } {
  const config = object(JSON.parse(readFileSync(path, "utf8")) as unknown);
  return loadHost(config, dirname(resolve(path)));
}
export function loadHost(config: Record<string, unknown>, directory: string): Record<string, unknown> & { templates: Record<string, unknown>[] } {
  if (!Array.isArray(config.templates)) throw new ServiceError("Invalid host template catalogue.", 400);
  const templates = config.templates.map(item => {
    const entry = object(item);
    if (!("templateFile" in entry)) { normalizeOperatorTemplate(entry); return structuredClone(entry); }
    only(entry, ["templateFile", "bindings"]);
    const file = text(entry.templateFile, "template file", 8000), bindings = object(entry.bindings ?? {});
    only(bindings, ["image", "pvc", "storageClass", "network", "secureBoot", "tpm", "ssh", "macOSRestoreImage", "macOSAuxiliaryStorage", "macOSHardwareModel"]);
    const definition = { ...object(JSON.parse(readFileSync(resolve(directory, file), "utf8")) as unknown), ...bindings };
    normalizeOperatorTemplate(definition); return definition;
  });
  const result: Record<string, unknown> & { templates: Record<string, unknown>[] } = { ...structuredClone(config), templates };
  if (Object.hasOwn(HOST_RUNTIMES, String(result.provider))) { enabledRuntimes(result); for (const image of templates) runtimeFor(result, image); }
  return result;
}
