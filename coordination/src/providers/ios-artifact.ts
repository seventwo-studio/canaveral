/** Materialize a verified, uncompressed ustar simulator application in a private stage. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import type { BigIntStats } from "node:fs";
import { ServiceError } from "../errors.ts";

const BLOCK = 512, CHUNK = 65536, MAX_ENTRIES = 100_000;
function invalid(message: string): never { throw new ServiceError(message, 400); }
function signature(info: BigIntStats): string { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"); }
function string(bytes: Buffer): string {
  const zero = bytes.indexOf(0), body = zero < 0 ? bytes : bytes.subarray(0, zero);
  if (zero >= 0 && bytes.subarray(zero).some(byte => byte !== 0)) invalid("Invalid ustar string padding.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { return invalid("Application archive paths must be valid UTF-8."); }
}
function octal(bytes: Buffer): number {
  if (bytes.some(byte => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) invalid("Application archive has an invalid octal field.");
  const value = bytes.toString("ascii").replace(/[\0 ]+$/g, "").replace(/^ +/, "");
  if (!/^[0-7]+$/.test(value)) invalid("Application archive has an invalid octal field.");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) invalid("Application archive field exceeds its numeric envelope.");
  return number;
}

/** The caller verifies the archive digest first and owns stage cleanup on success or failure. */
export async function materializeIosApp(archivePath: string, destination: string, options: { maxBytes: number; authorized: () => boolean | Promise<boolean> }): Promise<string> {
  const check = async () => { if (!await options.authorized()) throw new ServiceError("Application artifact authorization ended.", 401); };
  await check();
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1024) invalid("Invalid application archive size envelope.");
  const destinationInfo = await fs.lstat(destination, { bigint: true });
  if (!destinationInfo.isDirectory() || Number(destinationInfo.mode & 0o077n) !== 0 || await fs.realpath(destination) !== path.resolve(destination) || (await fs.readdir(destination)).length) invalid("Application extraction requires a fresh private directory.");
  const rootIdentity = `${destinationInfo.dev}:${destinationInfo.ino}`;
  const verifyRoot = async () => {
    await check();
    const current = await fs.lstat(destination, { bigint: true });
    if (!current.isDirectory() || `${current.dev}:${current.ino}` !== rootIdentity || await fs.realpath(destination) !== path.resolve(destination)) throw new ServiceError("Application staging directory changed.", 409);
  };
  const before = await fs.lstat(archivePath, { bigint: true });
  if (!before.isFile() || before.size > BigInt(options.maxBytes) || before.size < 1024n || before.size % 512n !== 0n) invalid("Expected a bounded uncompressed ustar application archive.");
  const archive = await fs.open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let offset = 0, total = 0, count = 0, files = 0, app: string | undefined;
  const explicit = new Set<string>(), directories = new Set<string>();
  const size = Number(before.size), buffer = Buffer.alloc(CHUNK);
  const unchanged = async () => {
    if (signature(before) !== signature(await archive.stat({ bigint: true })) || signature(before) !== signature(await fs.lstat(archivePath, { bigint: true }))) throw new ServiceError("Application archive changed during extraction.", 409);
  };
  const read = async (length: number): Promise<Buffer> => {
    if (length > CHUNK || offset + length > size) invalid("Application archive ended before its declared content.");
    let received = 0;
    while (received < length) {
      await check();
      const result = await archive.read(buffer, received, length - received, offset + received);
      if (!result.bytesRead) invalid("Application archive ended before its declared content.");
      received += result.bytesRead;
    }
    offset += length; return buffer.subarray(0, length);
  };
  const directory = async (relative: string) => {
    let current = "";
    for (const component of relative.split("/")) {
      current = current ? current + "/" + component : component;
      if (directories.has(current)) continue;
      if (directories.size + files >= MAX_ENTRIES) invalid("Application archive exceeds its extracted entry envelope.");
      await verifyRoot();
      await fs.mkdir(path.join(destination, current), { mode: 0o700 });
      directories.add(current);
    }
  };
  try {
    await unchanged();
    let ended = false;
    while (offset < size) {
      const header = Buffer.from(await read(BLOCK));
      if (header.every(byte => byte === 0)) {
        if (offset + BLOCK > size || (await read(BLOCK)).some(byte => byte !== 0)) invalid("Application archive is missing its end markers.");
        while (offset < size) if ((await read(Math.min(CHUNK, size - offset))).some(byte => byte !== 0)) invalid("Application archive contains trailing content.");
        ended = true; break;
      }
      if (++count > MAX_ENTRIES) invalid("Application archive exceeds its entry envelope.");
      const expected = octal(header.subarray(148, 156)); let checksum = 0;
      for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (checksum !== expected || !header.subarray(257, 263).equals(Buffer.from("ustar\0")) || header.subarray(263, 265).toString() !== "00") invalid("Application archive must use valid POSIX ustar headers.");
      const kind = header[156];
      if (![0, 48, 53].includes(kind!)) invalid("Application archive supports regular files and directories only.");
      const mode = octal(header.subarray(100, 108)), length = octal(header.subarray(124, 136));
      if (mode > 0o777 || string(header.subarray(157, 257))) invalid("Application archive contains unsupported permissions or links.");
      const name = string(header.subarray(0, 100)), prefix = string(header.subarray(345, 500));
      let relative = prefix ? prefix + "/" + name : name;
      if (kind === 53 && relative.endsWith("/")) relative = relative.slice(0, -1);
      const parts = relative.split("/");
      if (!relative || relative.includes("\\") || relative.includes(":") || parts.some(part => !part || part === "." || part === "..") || !parts[0]!.endsWith(".app") || parts[0] === ".app") invalid("Application archive must contain one .app directory without traversal.");
      if (!app) app = parts[0]!;
      if (parts[0] !== app || explicit.has(relative) || (parts.length === 1 && kind !== 53)) invalid("Application archive has duplicate paths or multiple application roots.");
      explicit.add(relative);
      if (kind === 53) {
        if (length !== 0) invalid("Application archive directories cannot contain file bytes.");
        await directory(relative);
      } else {
        if (++files + directories.size > MAX_ENTRIES) invalid("Application archive exceeds its extracted entry envelope.");
        total += length;
        if (total > options.maxBytes || length > size - offset) invalid("Application archive exceeds its declared size envelope.");
        await directory(parts.slice(0, -1).join("/"));
        await verifyRoot();
        const file = await fs.open(path.join(destination, relative), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode & 0o111 ? 0o700 : 0o600);
        try {
          let remaining = length;
          while (remaining) {
            const bytes = await read(Math.min(CHUNK, remaining)); let written = 0;
            while (written < bytes.length) {
              await check(); const result = await file.write(bytes, written, bytes.length - written);
              if (!result.bytesWritten) throw new ServiceError("Application archive file write was interrupted.", 409);
              written += result.bytesWritten;
            }
            remaining -= bytes.length;
          }
          await file.sync();
        } finally { await file.close(); }
        const padding = (BLOCK - length % BLOCK) % BLOCK;
        if (padding && (await read(padding)).some(byte => byte !== 0)) invalid("Application archive has invalid file padding.");
      }
    }
    if (!ended || !app || !explicit.has(app + "/Info.plist")) invalid("Application archive requires a complete .app with Info.plist.");
    const info = await fs.lstat(path.join(destination, app, "Info.plist"));
    if (!info.isFile() || info.size === 0) invalid("Application Info.plist must be a nonempty regular file.");
    await unchanged(); await verifyRoot(); return path.join(destination, app);
  } finally { await archive.close(); }
}
