import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { noLinks } from "../runtime-process.ts";
import { GuestUnavailableError } from "../errors.ts";
const limit = 256 * 1024;
const refuse = (): never => { throw new GuestUnavailableError("Owned Apple NAT evidence is unavailable or ambiguous.", 503, { retryable: false }); };
function ipv4(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split(".").map(Number);
  return [a,b,c,d].every(n => n! <= 255) && (a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168);
}
/** Supported bootpd format only. Unknown expiry is a live conflicting claimant. */
export function appleNATAddress(raw: string, mac: string, now: number): string {
  if (Buffer.byteLength(raw) > limit || !Number.isFinite(now) || now < 0 || !/^02(?::[0-9a-f]{2}){5}$/.test(mac)) return refuse();
  const records: Record<string, string>[] = [];
  let record: Record<string,string> | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim(); if (!text) continue;
    if (text === "{" && !record) { record = {}; continue; }
    if (text === "}" && record) { records.push(record); record = undefined; continue; }
    const match = /^([a-z_]+)=([^\s{}]+)$/.exec(text);
    if (!record || !match || Object.hasOwn(record, match[1]!)) return refuse();
    record[match[1]!] = match[2]!;
  }
  if (record) return refuse();
  const expiry = (r: Record<string,string>): number => /^0x[0-9a-fA-F]{1,8}$/.test(r.lease ?? "") ? parseInt(r.lease!,16) : Infinity;
  const matches = records.filter(r => r.hw_address === `1,${mac}`);
  if (matches.length !== 1) return refuse();
  const candidate = matches[0]!, address = candidate.ip_address;
  if (!address || !ipv4(address) || !Number.isFinite(expiry(candidate)) || expiry(candidate) <= now) return refuse();
  if (records.some(r => r !== candidate && r.ip_address === address && expiry(r) > now)) return refuse();
  return address;
}
/** Fixed local bootpd file; cap before and during read, never follow links/devices. */
export function readAppleNAT(): string {
  const path = "/private/var/db/dhcpd_leases"; noLinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd), named = lstatSync(path);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) || before.size > limit || before.dev !== named.dev || before.ino !== named.ino) return refuse();
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length-count, null); if (!n) break; count += n; }
    const after = fstatSync(fd), final = lstatSync(path);
    if (count > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || final.ino !== before.ino || final.dev !== before.dev) return refuse();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0,count));
  } finally { closeSync(fd); }
}
