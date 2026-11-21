/** Operator-requested runtime and system-image management, and orphan storage evidence.
 *
 * Nothing here runs on device reconciliation: a lease or machine creation never downloads.
 * Android uses the SDK's classic `sdkmanager` (deprecated upstream, like `avdmanager`); iOS
 * uses `xcodebuild -downloadPlatform` and `simctl runtime`. Installer and uninstaller output
 * never leaves the host: those reports carry fixed codes and numbers. Listings do carry what the
 * tools report about each runtime, bounded: identifiers, versions, descriptions, names and states.
 * No report carries a host path. The command lines follow the upstream documents
 * cited in docs/mobile-host-upkeep.md and have fixture coverage only; no native acceptance. */
import * as fs from "node:fs";
import * as path from "node:path";
import { ServiceError, object } from "../errors.ts";
import { legacyDigest } from "../control/templates.ts";
import { noLinks } from "../runtime-process.ts";
import { canonical, digest, readJson, readRegular, uuid } from "./mobile.ts";
import type { MobileProvider, NativePipe, RecordValue } from "./mobile.ts";
import type { AndroidProvider } from "./android.ts";
import type { IosProvider } from "./ios.ts";

export type RuntimePhase = "starting" | "downloading" | "installing" | "removing" | "verifying" | "inspecting";
export interface RuntimeContext {
  authorized(): boolean;
  timeoutSeconds: number;
  progress(update: { phase: RuntimePhase; percent?: number }): void;
  /** Host-level users of a runtime: configured templates and retained assignments. */
  uses(identifier: string): string[];
}
export interface RuntimeReport { state: "succeeded" | "failed" | "unknown"; result: RecordValue }
/** One thing a purge removes for an orphan, as the dry run lists it. */
export type OrphanRemoval = "device-storage" | "removal-quarantine" | "avd-registration" | "simulator" | "assignment-journal";
export interface OrphanEvidence {
  name: string; kind: "device-storage" | "removal-quarantine"; machineId: string;
  owned: boolean; removable: boolean; reason: string; leased?: boolean;
  /** Everything a purge of this entry would remove, when it is removable. */
  removes?: OrphanRemoval[];
  /** The host identity the owner receipt was issued to; compared by the host, never reported. */
  hostId?: string | null;
  /** Fingerprint of the assignment the owner receipt binds, for its matching local journal. */
  assignmentFingerprint?: string;
}
const failed = (code: string, detail: string, extra: RecordValue = {}): RuntimeReport => ({ state: "failed", result: { code, detail, ...extra } });
const unknown = (code: string, detail: string): RuntimeReport => code === "unstarted" ? failed("tool_unavailable", "The native tool could not be started; nothing was changed.") : { state: "unknown", result: { code, detail } };
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type ToolOutcome = { kind: "exit"; code: number; text: string } | { kind: "timeout" | "interrupted" | "error" | "unstarted"; text: string };
/** Runs one tool to completion with a hard deadline, optional stdin and bounded output.
 * Loss of authorization or the deadline closes the retained child; that outcome is uncertain. */
async function streamTool(provider: MobileProvider, argv: readonly string[], context: RuntimeContext, deadline: number, input?: Buffer,
  onText?: (text: string) => void): Promise<ToolOutcome> {
  let pipe: NativePipe, tail = "", interrupted = false;
  // No process exists when the pipe cannot be opened, so that alone is a definite failure.
  try { pipe = await provider.pipe(argv); } catch { return { kind: "unstarted", text: "" }; }
  const watcher = setInterval(() => { if (!context.authorized()) { interrupted = true; void pipe.close().catch(() => {}); } }, 250);
  try {
    if (input?.length) await pipe.write(input, 30_000);
    await pipe.end();
    for (;;) {
      const remaining = deadline - performance.now();
      if (interrupted) return { kind: "interrupted", text: tail };
      if (remaining <= 0) return { kind: "timeout", text: tail };
      let chunk: Buffer;
      try { chunk = Buffer.from(await pipe.read(65_536, remaining)); }
      catch { return { kind: interrupted ? "interrupted" : performance.now() >= deadline - 50 ? "timeout" : "error", text: tail }; }
      if (!chunk.length) break;
      const text = chunk.toString("utf8");
      // Only a bounded tail is kept, for fixed-pattern classification on this host.
      tail = (tail + text).slice(-16_384); onText?.(text);
    }
    if (interrupted) return { kind: "interrupted", text: tail };
    try { return { kind: "exit", code: await pipe.wait(Math.max(1000, Math.min(30_000, deadline - performance.now()))), text: tail }; }
    catch { return { kind: interrupted ? "interrupted" : "timeout", text: tail }; }
  } finally { clearInterval(watcher); await pipe.close().catch(() => {}); }
}
/** Percentages and a coarse phase are the only things read from installer output. */
function progressReader(context: RuntimeContext, initial: RuntimePhase): (text: string) => void {
  let phase = initial, percent: number | undefined, sent = Number.NEGATIVE_INFINITY;
  return text => {
    if (/download/i.test(text)) phase = "downloading"; else if (/unzip|install|extract|mount|verif/i.test(text)) phase = "installing";
    const matches = [...text.matchAll(/(\d{1,3})(?:\.\d+)?\s?%/g)], last = matches.at(-1);
    const next = last ? Math.min(100, Number(last[1])) : percent, now = performance.now();
    if (next === percent && now - sent < 5000 || now - sent < 1000) { percent = next; return; }
    percent = next; sent = now;
    context.progress({ phase, ...(percent === undefined ? {} : { percent }) });
  };
}
function hostAbi(provider: MobileProvider): string {
  const arch = String(provider.config.hostArch ?? (process.arch === "x64" ? "amd64" : process.arch));
  return arch === "arm64" ? "arm64-v8a" : "x86_64";
}
/** Devices (owned storage directories) under this runtime's storage root, with the runtime each
 * pins. An unreadable owner receipt yields `null`: such a device counts as using every runtime. */
export function storageDevices(provider: MobileProvider): { id: string; runtime: string | null }[] {
  const root = String(provider.config.storage), result: { id: string; runtime: string | null }[] = [];
  if (!path.isAbsolute(root) || !fs.existsSync(root)) return result;
  for (const name of fs.readdirSync(root)) {
    const id = /^(?:\.removing-)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/.exec(name)?.[1];
    if (!id || !fs.lstatSync(path.join(root, name)).isDirectory()) continue;
    let runtime: string | null = null;
    try {
      const device = object(object(object(readJson(path.join(root, name, "canaveral-owner.json"))?.binding).template).device);
      const value = provider.kind === "android" ? device.systemImage : device.runtime;
      if (typeof value === "string") runtime = value;
    } catch { /* Unproven storage is counted against every runtime. */ }
    result.push({ id, runtime });
  }
  return result;
}
function localUses(provider: MobileProvider, identifier: string, context: RuntimeContext): string[] {
  const devices = storageDevices(provider).filter(device => device.runtime === null || device.runtime === identifier);
  return [...context.uses(identifier), ...(devices.length ? ["device-storage"] : [])];
}

// Android system images.
function sdkRoot(provider: AndroidProvider): string {
  const sdk = String(provider.config.androidSDK);
  if (!path.isAbsolute(sdk)) throw new ServiceError("androidSDK must be absolute.", 400);
  return sdk;
}
function sdkManager(provider: AndroidProvider): string { return path.join(sdkRoot(provider), "cmdline-tools/latest/bin/sdkmanager"); }
function imageDirectory(provider: AndroidProvider, identifier: string): string { return path.join(sdkRoot(provider), ...identifier.split(";")); }
function androidImageInstalled(provider: AndroidProvider, identifier: string): boolean {
  const directory = imageDirectory(provider, identifier), properties = path.join(directory, "source.properties");
  return !!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() && !!fs.lstatSync(properties, { throwIfNoEntry: false })?.isFile();
}
/** Installed images come from the SDK directory itself, so listing them needs no network. */
export function androidInstalledImages(provider: AndroidProvider): { identifier: string; revision?: string; compatible: boolean }[] {
  const root = path.join(sdkRoot(provider), "system-images"), abi = hostAbi(provider), result: { identifier: string; revision?: string; compatible: boolean }[] = [];
  const directories = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^[A-Za-z0-9_.-]+$/.test(name) && fs.lstatSync(path.join(dir, name)).isDirectory()).sort() : [];
  for (const api of directories(root)) for (const tag of directories(path.join(root, api))) for (const arch of directories(path.join(root, api, tag))) {
    const identifier = `system-images;${api};${tag};${arch}`;
    if (!androidImageInstalled(provider, identifier) || result.length >= 500) continue;
    let revision: string | undefined;
    try { revision = /^Pkg\.Revision\s*=\s*([0-9][0-9A-Za-z.\- ]{0,40})$/m.exec(readRegular(path.join(root, api, tag, arch, "source.properties"), 65_536).toString("utf8"))?.[1]?.trim(); } catch { /* Revision is informative only. */ }
    result.push({ identifier, ...(revision ? { revision } : {}), compatible: arch === abi });
  }
  return result;
}
/** `sdkmanager --list`: rows of the "Available Packages" table that name system images. */
export function parseSdkManagerList(text: string, abi: string): { identifier: string; version: string; description: string; compatible: boolean }[] {
  const lines = text.split(/\r?\n/), start = lines.findIndex(line => /^Available Packages:/.test(line.trim())), result: { identifier: string; version: string; description: string; compatible: boolean }[] = [];
  if (start < 0) throw new Error("No available package table.");
  for (const line of lines.slice(start + 1)) {
    if (/^Available Updates:/.test(line.trim())) break;
    const columns = line.split("|").map(column => column.trim());
    if (columns.length < 3 || !/^system-images;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+$/.test(columns[0]!)) continue;
    if (result.length >= 1000) break;
    result.push({ identifier: columns[0]!, version: columns[1]!.slice(0, 40), description: columns[2]!.replace(/[^\x20-\x7e]/g, "").slice(0, 200), compatible: columns[0]!.endsWith(";" + abi) });
  }
  return result;
}
async function androidList(provider: AndroidProvider, context: RuntimeContext): Promise<RuntimeReport> {
  context.progress({ phase: "inspecting" });
  const devices = storageDevices(provider);
  const installed = androidInstalledImages(provider).map(image => ({ ...image, devices: devices.filter(device => device.runtime === image.identifier).length }));
  let available: RecordValue = { state: "unavailable" };
  try {
    const names = new Set(installed.map(image => image.identifier));
    const entries = parseSdkManagerList(await provider.runText([sdkManager(provider), `--sdk_root=${sdkRoot(provider)}`, "--list"], { timeoutMs: 120_000 }), hostAbi(provider));
    available = { state: "listed", entries: entries.map(entry => ({ ...entry, installed: names.has(entry.identifier) })) };
  } catch { /* Offline, or no usable sdkmanager: installed images are still reported. */ }
  return { state: "succeeded", result: { platform: "android", installed, available } };
}
async function androidInstall(provider: AndroidProvider, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport> {
  const identifier = String(args.identifier), tool = sdkManager(provider);
  if (androidImageInstalled(provider, identifier)) return { state: "succeeded", result: { platform: "android", identifier, alreadyInstalled: true } };
  // The host itself never answers a licence prompt without this request's acknowledgement.
  if (args.acceptLicenses !== true) return failed("license_acknowledgement_required", "Android installs need an explicit licence acknowledgement.");
  if (!fs.lstatSync(tool, { throwIfNoEntry: false })?.isFile()) return failed("tool_unavailable", "Install the Android SDK command-line tools on this host.");
  context.progress({ phase: "starting" });
  const outcome = await streamTool(provider, [tool, `--sdk_root=${sdkRoot(provider)}`, "--install", identifier], context, performance.now() + context.timeoutSeconds * 1000,
    Buffer.from("y\n".repeat(64)), progressReader(context, "downloading"));
  if (outcome.kind !== "exit") return unknown(outcome.kind, "The Android installer did not finish; list this host's system images before another change.");
  context.progress({ phase: "verifying" });
  if (androidImageInstalled(provider, identifier)) return { state: "succeeded", result: { platform: "android", identifier, installed: true } };
  if (outcome.code === 0) return unknown("not_verified", "The installer finished but the system image is not present; list before another change.");
  const licence = /licen[cs]e/i.test(outcome.text) && /not (?:been )?accepted/i.test(outcome.text);
  return failed(licence ? "license_not_accepted" : "installer_failed", "The Android installer reported a failure and the system image is not installed.", { exitCode: outcome.code });
}
async function androidRemove(provider: AndroidProvider, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport> {
  const identifier = String(args.identifier), tool = sdkManager(provider);
  const usedBy = [...new Set(localUses(provider, identifier, context))];
  if (usedBy.length) return failed("runtime_in_use", "A template or device on this host uses that system image.", { usedBy });
  if (!androidImageInstalled(provider, identifier)) return { state: "succeeded", result: { platform: "android", identifier, alreadyAbsent: true } };
  if (!fs.lstatSync(tool, { throwIfNoEntry: false })?.isFile()) return failed("tool_unavailable", "Install the Android SDK command-line tools on this host.");
  context.progress({ phase: "removing" });
  const outcome = await streamTool(provider, [tool, `--sdk_root=${sdkRoot(provider)}`, "--uninstall", identifier], context, performance.now() + context.timeoutSeconds * 1000);
  if (outcome.kind !== "exit") return unknown(outcome.kind, "The Android uninstaller did not finish; list this host's system images before another change.");
  context.progress({ phase: "verifying" });
  if (!androidImageInstalled(provider, identifier)) return { state: "succeeded", result: { platform: "android", identifier, removed: true } };
  return outcome.code === 0 ? unknown("not_verified", "The uninstaller finished but the system image is still present; list before another change.")
    : failed("uninstall_failed", "The Android uninstaller reported a failure and the system image is still installed.", { exitCode: outcome.code });
}

// iOS simulator runtimes.
const IOS_PREFIX = "com.apple.CoreSimulator.SimRuntime.iOS-";
function xcodebuild(provider: IosProvider): string { return String(provider.config.xcodebuild ?? "xcodebuild"); }
async function iosRuntimes(provider: IosProvider): Promise<RecordValue[]> {
  const runtimes = object(JSON.parse(await provider.simctl(["list", "runtimes", "--json"]))).runtimes;
  if (!Array.isArray(runtimes)) throw new ServiceError("Malformed simulator runtime inventory.");
  return runtimes.map(object).filter(runtime => typeof runtime.identifier === "string" && runtime.identifier.startsWith(IOS_PREFIX));
}
/** `simctl runtime list -j`: disk images keyed by image identifier. Older Xcode has no such listing. */
async function iosImages(provider: IosProvider): Promise<RecordValue[]> {
  return Object.values(object(JSON.parse(await provider.simctl(["runtime", "list", "-j"])))).map(object).filter(image => typeof image.identifier === "string" && typeof image.runtimeIdentifier === "string");
}
async function iosList(provider: IosProvider, context: RuntimeContext): Promise<RuntimeReport> {
  context.progress({ phase: "inspecting" });
  const runtimes = await iosRuntimes(provider), text = (value: unknown): string | undefined => typeof value === "string" ? value.slice(0, 200) : undefined;
  let images: RecordValue[] | undefined, devices: Record<string, number> = {};
  try { images = await iosImages(provider); } catch { /* Image state and removal need a newer Xcode. */ }
  try { for (const { runtime } of await provider.inventory()) devices[runtime] = (devices[runtime] ?? 0) + 1; } catch { devices = {}; }
  const installed = runtimes.slice(0, 200).map(runtime => ({ identifier: runtime.identifier, version: text(runtime.version), build: text(runtime.buildversion), name: text(runtime.name), usable: runtime.isAvailable === true,
    // Every simulator under the runtime counts, including devices Canaveral did not create.
    devices: devices[String(runtime.identifier)] ?? 0,
    ...(images ? { images: images.filter(image => image.runtimeIdentifier === runtime.identifier).map(image => ({ imageId: image.identifier, state: text(image.state), deletable: image.deletable === true, kind: text(image.kind),
      ...(typeof image.sizeBytes === "number" ? { sizeBytes: image.sizeBytes } : {}) })) } : {}) }));
  // Xcode has no command that lists every downloadable runtime. What it can name is the runtime
  // its own SDK selects, which is what `xcodebuild -downloadPlatform iOS` fetches.
  let available: RecordValue = { state: "unavailable" };
  try {
    const entries = Object.values(object(JSON.parse(await provider.simctl(["runtime", "match", "list", "-j"])))).map(object)
      .filter(rule => rule.platform === "com.apple.platform.iphoneos" && typeof rule.sdkVersion === "string" && /^[0-9]+(?:\.[0-9]+){1,2}$/.test(rule.sdkVersion))
      .map(rule => { const identifier = IOS_PREFIX + String(rule.sdkVersion).replaceAll(".", "-");
        return { identifier, version: rule.sdkVersion, build: text(rule.defaultBuild), source: "xcode-default", installed: installed.some(runtime => runtime.identifier === identifier || runtime.build !== undefined && runtime.build === rule.defaultBuild) }; });
    available = { state: "listed", entries, scope: "selected-xcode-default" };
  } catch { /* Unavailable on this Xcode. */ }
  return { state: "succeeded", result: { platform: "ios", installed, available } };
}
async function iosInstall(provider: IosProvider, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport> {
  const identifier = String(args.identifier), version = identifier.slice(IOS_PREFIX.length).replaceAll("-", "."), tool = xcodebuild(provider);
  if (!/^[0-9]+(?:\.[0-9]+){1,2}$/.test(version)) return failed("invalid_identifier", "Name an iOS runtime by its version identifier.");
  const usable = async (): Promise<boolean> => (await iosRuntimes(provider)).some(runtime => runtime.identifier === identifier && runtime.isAvailable === true);
  if (await usable()) return { state: "succeeded", result: { platform: "ios", identifier, alreadyInstalled: true } };
  if (!await provider.transport?.executableAvailable?.(tool)) return failed("tool_unavailable", "Install full Xcode and select its developer directory on this host.");
  context.progress({ phase: "starting" });
  const outcome = await streamTool(provider, [tool, "-downloadPlatform", "iOS", "-buildVersion", version], context, performance.now() + context.timeoutSeconds * 1000, undefined, progressReader(context, "downloading"));
  if (outcome.kind !== "exit") return unknown(outcome.kind, "The runtime download did not finish; list this host's runtimes before another change.");
  context.progress({ phase: "verifying" });
  let present: boolean;
  try { present = await usable(); } catch { return unknown("not_verified", "The runtime inventory could not be read after the download; list before another change."); }
  if (present) return { state: "succeeded", result: { platform: "ios", identifier, installed: true } };
  return outcome.code === 0 ? unknown("not_verified", "The download finished but the runtime is not usable yet; list before another change.")
    : failed("installer_failed", "Xcode reported a failure and the runtime is not installed.", { exitCode: outcome.code });
}
async function iosRemove(provider: IosProvider, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport> {
  const identifier = String(args.identifier);
  let images: RecordValue[], runtimes: RecordValue[], simulators: number;
  try { images = (await iosImages(provider)).filter(image => image.runtimeIdentifier === identifier); runtimes = await iosRuntimes(provider); simulators = (await provider.inventory()).filter(entry => entry.runtime === identifier).length; }
  catch { return failed("tool_unavailable", "This Xcode cannot list runtime disk images; nothing was removed."); }
  // `simctl runtime delete` shuts down booted simulators of that runtime, so any simulator under
  // it refuses the removal, including devices Canaveral did not create.
  const usedBy = [...new Set([...localUses(provider, identifier, context), ...(simulators ? ["simulator"] : [])])];
  if (usedBy.length) return failed("runtime_in_use", "A template or simulator on this host uses that runtime.", { usedBy });
  if (!images.length) return runtimes.some(runtime => runtime.identifier === identifier)
    ? failed("not_removable", "That runtime is not a removable disk image on this host.") : { state: "succeeded", result: { platform: "ios", identifier, alreadyAbsent: true } };
  const image = images[0]!;
  if (images.length !== 1 || image.deletable !== true || !/^[0-9A-Fa-f-]{36}$/.test(String(image.identifier))) return failed("not_removable", "That runtime is not a single removable disk image on this host.");
  context.progress({ phase: "removing" });
  const deadline = performance.now() + context.timeoutSeconds * 1000;
  const outcome = await streamTool(provider, [String(provider.config.xcrun ?? "xcrun"), "simctl", "runtime", "delete", String(image.identifier)], context, deadline);
  if (outcome.kind !== "exit") return unknown(outcome.kind, "The runtime removal did not finish; list this host's runtimes before another change.");
  context.progress({ phase: "verifying" });
  // Deletion can complete shortly after the command returns.
  for (let attempt = 0; attempt < 30 && performance.now() < deadline && context.authorized(); attempt++) {
    try { if (!(await iosImages(provider)).some(candidate => candidate.identifier === image.identifier)) return { state: "succeeded", result: { platform: "ios", identifier, removed: true } }; }
    catch { break; }
    if (outcome.code !== 0) break;
    await sleep(Number(provider.config.runtimePollMilliseconds ?? 2000));
  }
  return outcome.code === 0 ? unknown("not_verified", "The removal was requested but the runtime image is still listed; list before another change.")
    : failed("uninstall_failed", "Xcode reported a failure and the runtime image is still present.", { exitCode: outcome.code });
}

/** One entry point per provider. Failures before any tool ran are `failed`; anything after is `unknown`. */
export async function runtimeOperation(provider: AndroidProvider | IosProvider, kind: string, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport> {
  const android = provider.kind === "android";
  if (!context.authorized()) return failed("unauthorized", "Authorization ended before the operation started.");
  try {
    if (kind === "runtime-list") return await (android ? androidList(provider as AndroidProvider, context) : iosList(provider as IosProvider, context));
    if (kind === "runtime-install") return await (android ? androidInstall(provider as AndroidProvider, args, context) : iosInstall(provider as IosProvider, args, context));
    if (kind === "runtime-remove") return await (android ? androidRemove(provider as AndroidProvider, args, context) : iosRemove(provider as IosProvider, args, context));
  } catch {
    // A listing changes nothing, so its failure is definite. A change that stopped unexpectedly may have run its tool.
    return kind === "runtime-list" ? failed("inventory_unavailable", "This host could not read its runtime inventory; nothing was changed.")
      : unknown("error", "The operation stopped unexpectedly; list this host's runtimes before another change.");
  }
  return failed("unsupported", "Unsupported runtime operation.");
}

// Orphan storage: read-only evidence, then an explicit purge that re-proves it.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const QUARANTINE = /^\.removing-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function identity(file: string): string | null { const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }); return stat ? `${stat.dev}/${stat.ino}` : null; }
/** The owner receipt Canaveral wrote when it created this storage. It must bind this machine ID
 * and this exact runtime: its kind, runner state directory, storage root and SDK or xcrun
 * setting. The host identity the receipt names is returned for the host to compare; nothing in
 * a receipt names a controller. */
function ownerEvidence(provider: MobileProvider, name: string): OrphanEvidence & { directory: string; binding?: RecordValue } {
  const quarantine = QUARANTINE.exec(name), machineId = quarantine?.[1] ?? name, root = String(provider.config.storage), directory = path.join(root, name);
  const base = { name, kind: quarantine ? "removal-quarantine" as const : "device-storage" as const, machineId, owned: false, removable: false, directory };
  if (!path.isAbsolute(root) || !quarantine && !UUID.test(name)) return { ...base, reason: "not_an_assignment_name" };
  try {
    noLinks(directory);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || process.getuid && stat.uid !== process.getuid() || stat.mode & 0o077) return { ...base, reason: "not_private_owned_directory" };
    const marker = readJson(path.join(directory, "canaveral-owner.json"));
    if (!marker) return { ...base, reason: "no_owner_receipt" };
    const binding = object(marker.binding), expected = { kind: provider.kind, state: provider.state, storage: provider.config.storage, androidSDK: provider.config.androidSDK ?? null, xcrun: provider.config.xcrun ?? null };
    if (binding.version !== 1 || binding.id !== machineId || marker.fingerprint !== digest(binding) || canonical(binding.runtime) !== canonical(expected)) return { ...base, reason: "owner_receipt_differs" };
    return { ...base, owned: true, reason: "owned", leased: binding.lease !== null, binding, hostId: typeof binding.hostId === "string" ? binding.hostId : null,
      assignmentFingerprint: legacyDigest({ id: binding.id, template: object(binding.template), resources: object(binding.resources) }) };
  } catch { return { ...base, reason: "ownership_unreadable" }; }
}
function publicEvidence(evidence: ReturnType<typeof ownerEvidence>, removable: boolean, reason: string, removes: OrphanRemoval[] = []): OrphanEvidence {
  const { directory: _directory, binding: _binding, ...rest } = evidence;
  return { ...rest, removable, reason, ...(removable ? { removes } : {}) };
}
/** The registration of this assignment's AVD, while it points at that assignment's own storage. */
function ownRegistration(provider: AndroidProvider, machineId: string): { file: string; state: "absent" | "own" | "differs" } {
  const file = path.join(provider.environment().ANDROID_AVD_HOME!, provider.name({ id: machineId }) + ".ini");
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { file, state: "absent" };
  if (!fs.lstatSync(file).isFile()) return { file, state: "differs" };
  const paths = readRegular(file, 65_536).toString("utf8").split(/\r?\n/).filter(line => line.startsWith("path="));
  return { file, state: paths.length === 1 && paths[0] === "path=" + path.join(String(provider.config.storage), machineId, "device.avd") ? "own" : "differs" };
}
export async function androidOrphan(provider: AndroidProvider, name: string): Promise<OrphanEvidence> {
  const evidence = ownerEvidence(provider, name), dir = evidence.directory, refuse = (reason: string) => publicEvidence(evidence, false, reason);
  if (!evidence.owned) return refuse(evidence.reason);
  try {
    const registration = ownRegistration(provider, evidence.machineId), removes: OrphanRemoval[] = [evidence.kind, ...(registration.state === "own" ? ["avd-registration" as const] : [])];
    // A quarantine exists only after this runner proved the stop and began removing the storage.
    // A registration that no longer points at that assignment's AVD is left where it is.
    if (evidence.kind === "removal-quarantine") return publicEvidence(evidence, true, "interrupted_removal", removes);
    if (fs.existsSync(path.join(dir, "assignment.lock"))) return refuse("assignment_lock_present");
    const launch = readJson(path.join(dir, "launch.json")), endpoint = readJson(path.join(dir, "endpoint.json")), lease = evidence.binding!.lease === null ? null : object(evidence.binding!.lease);
    if (lease || launch?.supervised === true) {
      // The lease supervisor's stop receipt, or positively absent processes, is the only stop proof.
      if (!lease || !await provider.leaseStopped({ id: evidence.machineId, lease: { id: lease.id } }, dir)) return refuse("execution_not_proven_stopped");
    } else if (launch || endpoint) {
      const pid = launch?.pid;
      if (!Number.isSafeInteger(pid) || await provider.transport?.processAbsent?.(pid as number) !== true) return refuse("execution_not_proven_stopped");
      if (endpoint && `emulator-${String(endpoint.port)}` in await provider.devices()) return refuse("device_connected");
    }
    if (registration.state === "differs") return refuse("avd_registration_differs");
    return publicEvidence(evidence, true, "owned_and_stopped", removes);
  } catch { return refuse("evidence_unavailable"); }
}
/** The simulator a receipt names, when it is listed under the assignment's own name. */
async function receiptedSimulator(provider: IosProvider, directory: string, machineId: string): Promise<{ state: "none" | "absent" | "differs" | "running" | "shutdown" | "unreceipted"; udid?: string }> {
  const receipt = readJson(path.join(directory, "simulator.json")), inventory = await provider.inventory(), assigned = provider.name({ id: machineId });
  if (!receipt) return { state: inventory.some(({ device }) => device.name === assigned) ? "unreceipted" : "none" };
  const udid = uuid(receipt.udid), found = inventory.filter(({ device }) => typeof device.udid === "string" && device.udid.toLowerCase() === udid);
  if (!found.length) return { state: "absent", udid };
  if (found.length > 1 || found[0]!.device.name !== assigned) return { state: "differs", udid };
  return { state: found[0]!.device.state === "Shutdown" ? "shutdown" : "running", udid };
}
export async function iosOrphan(provider: IosProvider, name: string): Promise<OrphanEvidence> {
  const evidence = ownerEvidence(provider, name), dir = evidence.directory, refuse = (reason: string) => publicEvidence(evidence, false, reason);
  if (!evidence.owned) return refuse(evidence.reason);
  try {
    if (fs.existsSync(path.join(dir, "assignment.lock"))) return refuse("assignment_lock_present");
    const simulator = await receiptedSimulator(provider, dir, evidence.machineId);
    if (simulator.state === "differs") return refuse("simulator_identity_differs");
    // A purge removes storage; it never shuts a simulator down.
    if (simulator.state === "running") return refuse("simulator_running");
    if (simulator.state === "unreceipted") return refuse("simulator_without_receipt");
    return publicEvidence(evidence, true, evidence.kind === "removal-quarantine" ? "interrupted_removal" : "owned_and_stopped", [evidence.kind, ...(simulator.state === "shutdown" ? ["simulator" as const] : [])]);
  } catch { return refuse("evidence_unavailable"); }
}
/** AVD registrations and simulators that carry an assignment's name but have no storage
 * directory, and so no owner receipt. A name proves nothing: they are reported, never removed. */
export async function strayDevices(provider: AndroidProvider | IosProvider): Promise<{ name: string; machineId: string; kind: "avd-registration" | "simulator" }[]> {
  const root = String(provider.config.storage), stored = new Set(storageDevices(provider).map(device => device.id));
  const named = /^cvm-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(\.ini)?$/, result: { name: string; machineId: string; kind: "avd-registration" | "simulator" }[] = [];
  if (!path.isAbsolute(root)) return result;
  if (provider.kind === "android") {
    const registry = (provider as AndroidProvider).environment().ANDROID_AVD_HOME!;
    for (const name of fs.existsSync(registry) ? fs.readdirSync(registry).sort() : []) {
      const id = named.exec(name);
      if (id?.[2] && !stored.has(id[1]!) && result.length < 100) result.push({ name, machineId: id[1]!, kind: "avd-registration" });
    }
  } else for (const { device } of await (provider as IosProvider).inventory()) {
    const id = typeof device.name === "string" ? named.exec(device.name) : null;
    if (id && !id[2] && !stored.has(id[1]!) && result.length < 100) result.push({ name: String(device.name), machineId: id[1]!, kind: "simulator" });
  }
  return result;
}
/** Removes one proven orphan and returns what it removed. Nothing is stopped: a simulator is
 * deleted only when its receipt names it and it is shut down. The evidence is read again here,
 * so what is removed is what an inspection at this moment would list.
 *
 * A purge is never resumed: its host operation runs once. One that stops part-way leaves the
 * storage in its `.removing-` quarantine or untouched. A new purge requires ownership proof on
 * the remaining entry. A failure after the first change is reported as uncertain. */
export async function purgeOrphan(provider: AndroidProvider | IosProvider, name: string, requestId: string, hostId: string | undefined): Promise<{ assignmentFingerprint: string | undefined; removed: OrphanRemoval[] }> {
  const request = uuid(requestId), root = String(provider.config.storage);
  const directory = path.join(root, name), quarantine = QUARANTINE.test(name) ? directory : path.join(root, `.removing-${name}-${request}`);
  const uncertain = (message: string): ServiceError => new ServiceError(message, 409, { outcome: "unknown" });
  const refused = (message: string): ServiceError => new ServiceError(message, 409, { code: "orphan_refused" });
  const evidence = provider.kind === "android" ? await androidOrphan(provider as AndroidProvider, name) : await iosOrphan(provider as IosProvider, name);
  // The receipt must still name the host identity this runner holds, as the inspection required.
  if (!evidence.removable || !hostId || evidence.hostId !== hostId) throw refused("Storage is not a proven orphan of this host.");
  const storageIdentity = identity(directory), also: OrphanRemoval[] = [];
  if (!storageIdentity) throw refused("Storage disappeared before its purge.");
  if (quarantine !== directory && identity(quarantine)) throw refused("Removal quarantine is already occupied.");
  if (provider.kind === "ios") {
    const ios = provider as IosProvider;
    // Owned by receipt and name, shut down, and read again immediately before the delete.
    const simulator = await receiptedSimulator(ios, directory, evidence.machineId);
    if (simulator.state !== "none" && simulator.state !== "absent" && simulator.state !== "shutdown") throw refused("Simulator changed before its purge.");
    if (simulator.state === "shutdown") {
      await ios.simctl(["delete", simulator.udid!]);
      if ((await receiptedSimulator(ios, directory, evidence.machineId)).state !== "absent") throw uncertain("Simulator removal is unconfirmed.");
      also.push("simulator");
    }
  }
  try {
    if (identity(directory) !== storageIdentity) throw uncertain("Storage changed during its purge.");
    if (quarantine !== directory) fs.renameSync(directory, quarantine);
    if (provider.kind === "android") {
      const registration = ownRegistration(provider as AndroidProvider, evidence.machineId);
      if (registration.state === "own") { fs.unlinkSync(registration.file); also.push("avd-registration"); }
    }
    fs.rmSync(quarantine, { recursive: true });
    if (identity(quarantine) || identity(directory)) throw uncertain("Storage removal remains incomplete.");
    const parent = fs.openSync(root, fs.constants.O_RDONLY); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch (error) {
    // From here something may already be gone, so no failure is a clean refusal.
    throw error instanceof ServiceError && error.outcome === "unknown" ? error : uncertain("Storage removal stopped part-way.");
  }
  return { assignmentFingerprint: evidence.assignmentFingerprint, removed: [evidence.kind, ...also] };
}
