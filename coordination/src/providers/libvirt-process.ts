import * as fs from "node:fs";
import type { ProcessBirth } from "./libvirt.ts";
import { refuse } from "./libvirt-ownership.ts";

function procStat(pid: number): { parentPid: number; createdAt: number; zombie: boolean } {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  if (!stat.startsWith(`${pid} (`) || stat.lastIndexOf(")") < 0) refuse("Invalid supervisor process record.");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/ +/);
  const parentPid = Number(fields[1]), createdAt = Number(fields[19]);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !Number.isSafeInteger(createdAt) || createdAt <= 0) refuse("Invalid supervisor process birth.");
  return { parentPid, createdAt, zombie: fields[0] === "Z" || fields[0] === "X" };
}

export function linuxLibvirtBirth(pid: number): ProcessBirth | "gone" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 1) return "unknown";
  let first: ReturnType<typeof procStat>;
  try { first = procStat(pid); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown"; }
  if (first.zombie) return "gone";
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = Number(/^Uid:\s+(\d+)\s/m.exec(status)?.[1]);
    const executable = fs.readlinkSync(`/proc/${pid}/exe`);
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const second = procStat(pid);
    if (!Number.isSafeInteger(uid) || !raw.endsWith("\0") || first.createdAt !== second.createdAt ||
        first.parentPid !== second.parentPid || second.zombie) return "unknown";
    return { pid, ...first, uid, executable, argv: raw.slice(0, -1).split("\0") };
  } catch { return "unknown"; }
}

