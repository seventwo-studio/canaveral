/** What a lease holder may see of a simulator's app inventory and logs. `simctl listapps`
 * prints an old-style property list whose values carry absolute host paths (the storage
 * root, the account's home, the device set and the device identity). A lease gets the
 * bundle identifiers and descriptive fields only, parsed here; raw output is never returned. */
import { ServiceError } from "../errors.ts";

export interface LeasedApp { bundleId: string; name?: string; version?: string; type?: string }
type Plist = string | Plist[] | { [key: string]: Plist };
const MAX_DEPTH = 32, MAX_NODES = 200_000, MAX_APPS = 2000;
const bare = /[A-Za-z0-9_$+/:.-]/;

/** A bounded reader for the old-style (NeXTSTEP) property list `simctl` prints. It rejects
 * anything it does not understand: the caller fails the action instead of guessing. */
export function parsePlist(text: string): Plist {
  let at = 0, nodes = 0;
  const fail = (): never => { throw new ServiceError("Simulator app inventory could not be read.", 409); };
  const skip = (): void => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at]!)) at++;
      if (text.startsWith("/*", at)) { const end = text.indexOf("*/", at + 2); if (end < 0) fail(); at = end + 2; }
      else if (text.startsWith("//", at)) { const end = text.indexOf("\n", at); at = end < 0 ? text.length : end; }
      else return;
    }
  };
  const string = (): string => {
    if (text[at] !== '"') {
      const start = at;
      while (at < text.length && bare.test(text[at]!)) at++;
      if (at === start) fail();
      return text.slice(start, at);
    }
    let value = "";
    for (at++; at < text.length && text[at] !== '"'; at++) {
      if (text[at] !== "\\") { value += text[at]; continue; }
      const next = text[++at];
      if (next === undefined) fail();
      const unicode = next === "U" || next === "u" ? /^[0-9a-fA-F]{4}/.exec(text.slice(at + 1)) : null, octal = /^[0-7]{1,3}/.exec(text.slice(at));
      if (unicode) { value += String.fromCharCode(parseInt(unicode[0], 16)); at += 4; }
      else if (octal) { value += String.fromCharCode(parseInt(octal[0], 8)); at += octal[0].length - 1; }
      else value += ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[next!] ?? next;
    }
    if (text[at] !== '"') fail();
    at++;
    return value;
  };
  const value = (depth: number): Plist => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) fail();
    skip();
    if (text[at] === "{") {
      const result: { [key: string]: Plist } = Object.create(null);
      for (at++; ; ) {
        skip();
        if (text[at] === "}") { at++; return result; }
        const key = string(); skip();
        if (text[at++] !== "=") fail();
        result[key] = value(depth + 1); skip();
        if (text[at++] !== ";") fail();
      }
    }
    if (text[at] === "(") {
      const result: Plist[] = [];
      for (at++; ; ) {
        skip();
        if (text[at] === ")") { at++; return result; }
        result.push(value(depth + 1)); skip();
        if (text[at] === ",") at++; else if (text[at] !== ")") fail();
      }
    }
    if (text[at] === "<") { const end = text.indexOf(">", at); if (end < 0) fail(); const data = text.slice(at, end + 1); at = end + 1; return data; }
    return string();
  };
  const result = value(0);
  skip();
  if (at !== text.length) fail();
  return result;
}

/** Bundle identifier, display name, version and type of every installed app. Nothing else of
 * the listing leaves the host: no path, container or group location. */
export function leasedApps(listing: string): LeasedApp[] {
  const parsed = parsePlist(listing);
  if (typeof parsed === "string" || Array.isArray(parsed)) throw new ServiceError("Simulator app inventory could not be read.", 409);
  const field = (entry: { [key: string]: Plist }, ...keys: string[]): string | undefined => {
    for (const key of keys) { const found = entry[key]; if (typeof found === "string" && found && found.length <= 200 && !found.includes("/")) return found; }
    return undefined;
  };
  const apps: LeasedApp[] = [];
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string" || Array.isArray(entry)) continue;
    const bundleId = field(entry, "CFBundleIdentifier") ?? key;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/.test(bundleId)) continue;
    const name = field(entry, "CFBundleDisplayName", "CFBundleName"), version = field(entry, "CFBundleVersion"), type = field(entry, "ApplicationType");
    apps.push({ bundleId, ...(name ? { name } : {}), ...(version ? { version } : {}), ...(type ? { type } : {}) });
  }
  apps.sort((a, b) => a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0);
  if (apps.length > MAX_APPS) throw new ServiceError("Simulator app inventory exceeds its bound.", 413);
  return apps;
}

/** Replaces this host's own locations and the device identity in text a lease holder will
 * read. `locations` are absolute paths with the label that stands in for each. It removes
 * what identifies the host's layout; it cannot remove what an app or the system chose to log. */
export function redactHost(text: string, locations: readonly (readonly [string, string])[], udid: string): string {
  let result = text;
  // Longest first, so a nested path is replaced before the directory that contains it.
  for (const [location, label] of [...locations].filter(([location]) => location.length > 3 && location.startsWith("/")).sort((a, b) => b[0].length - a[0].length)) {
    for (const form of [`/private${location}`, location]) result = result.split(form).join(label);
  }
  return /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(udid) ? result.replace(new RegExp(udid, "gi"), "<udid>") : result;
}

/** The last `lines` lines of a log, within `bytes`. Whole lines only: a final line that alone
 * exceeds `bytes` yields nothing. One pass from the end, so a log of long lines costs no more. */
export function tail(text: string, lines: number, bytes: number): { output: string; truncated: boolean } {
  const all = text.split("\n");
  let first = all.length, size = 0;
  while (first > 0 && all.length - first < lines) {
    const next = Buffer.byteLength(all[first - 1]!) + (first < all.length ? 1 : 0);
    if (size + next > bytes) break;
    size += next;
    first--;
  }
  return { output: all.slice(first).join("\n"), truncated: first > 0 };
}
