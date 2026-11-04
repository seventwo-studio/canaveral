import { useEffect, useRef, useState } from "react";
import { imageTask, registryEntries } from "@/lib/catalogue";
import type {
  CatalogueHost,
  ImageTask,
  Refresh,
  RegistryEntry,
} from "@/lib/catalogue";
import { Download, ExternalLink } from "lucide-react";
import { api, memory, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function BaseImageRegistry({
  hosts,
  onClose,
  onImportFile,
  onRefresh,
}: {
  hosts: CatalogueHost[];
  onClose: () => void;
  onImportFile: (entry: RegistryEntry) => void;
  onRefresh: Refresh;
}) {
  const candidates = hosts.filter(
    (h) => h.online && h.kind !== "orchestrator" && h.provider !== "kubevirt",
  );
  const [entries, setEntries] = useState<RegistryEntry[]>([]),
    [query, setQuery] = useState(""),
    [os, setOs] = useState("all"),
    [arch, setArch] = useState("all");
  const [host, setHost] = useState(candidates[0]?.id || ""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [task, setTask] = useState<ImageTask | null>(null);
  const intents = useRef(new Map<string, string>()),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    api("image-registry", undefined, registryEntries)
      .then((value) => {
        if (alive.current) setEntries(value);
      })
      .catch((e) => {
        if (alive.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!task || !["queued", "running"].includes(task.state)) return;
    const taskId = task.id;
    let stopped = false,
      inFlight = false;
    const timer = setInterval(async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const value = await api(`image-tasks/${taskId}`, undefined, (value) =>
          imageTask(value, taskId),
        );
        if (!stopped) {
          setTask(value);
          if (value.state === "succeeded") await onRefresh();
        }
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      } finally {
        inFlight = false;
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [task?.id, task?.state, onRefresh]);
  async function importEntry(entry: RegistryEntry) {
    setBusy(true);
    setError("");
    const fingerprint = JSON.stringify([host, entry.id]);
    if (!intents.current.has(fingerprint))
      intents.current.set(fingerprint, crypto.randomUUID());
    const taskId = intents.current.get(fingerprint)!;
    try {
      const value = await api(
        "image-registry/imports",
        {
          id: taskId,
          hostId: host,
          registryId: entry.id,
          ...(entry.os === "linux" && entry.mediaType === "disk"
            ? { guestAccess: true }
            : {}),
        },
        (value) => imageTask(value, taskId),
      );
      if (alive.current) setTask(value);
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const pending = !!task && ["queued", "running"].includes(task.state);
  const selectedHost = candidates.find((h) => h.id === host);
  const hostArch = selectedHost?.health?.environment?.arch;
  const visible = entries.filter(
    (e) =>
      (os === "all" || e.os === os) &&
      (arch === "all" || e.arch === arch) &&
      `${e.name} ${e.publisher} ${e.note}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Base image registry</DialogTitle>
          <DialogDescription>
            Official OS sources. Import a base image onto a host, configure a
            machine, then capture your own reusable image.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            Import onto host
            <select
              aria-label="Registry target host"
              className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            >
              <option value="">Select a host</option>
              {candidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            Search registry
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ubuntu, macOS, Windows…"
            />
          </label>
          <label className="space-y-1 text-xs">
            Operating system
            <select
              className="h-9 w-full rounded-md border bg-background px-2"
              value={os}
              onChange={(e) => setOs(e.target.value)}
            >
              <option value="all">All operating systems</option>
              <option value="linux">Linux</option>
              <option value="macos">macOS</option>
              <option value="windows">Windows</option>
            </select>
          </label>
          <label className="space-y-1 text-xs">
            Architecture
            <select
              className="h-9 w-full rounded-md border bg-background px-2"
              value={arch}
              onChange={(e) => setArch(e.target.value)}
            >
              <option value="all">All architectures</option>
              <option value="arm64">ARM64</option>
              <option value="amd64">x86-64</option>
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="break-words text-xs text-destructive">
            {error}
          </p>
        )}
        {task && (
          <section
            aria-label="Registry import status"
            className="space-y-2 rounded-md border p-3 text-xs"
            aria-live="polite"
          >
            <p className="font-medium">
              {task.name} · {task.state}
            </p>
            <p className="break-all text-muted-foreground">
              {task.state === "queued"
                ? "Resolving the publisher’s current image before reserving storage."
                : task.state === "running"
                  ? "Downloading and verifying on the host. You can continue in the background."
                  : task.state === "succeeded"
                    ? "Imported and registered. The image is now in your host catalogue."
                    : task.result?.detail ||
                      "Inspect the image task before retrying."}
            </p>
            <p className="break-all text-muted-foreground">Task {task.id}</p>
          </section>
        )}
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading registry…</p>
        ) : !visible.length ? (
          <p className="text-xs text-muted-foreground">
            No images match these filters.
          </p>
        ) : (
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {visible.map((e) => {
              const mismatch =
                ["arm64", "amd64"].includes(hostArch ?? "") &&
                hostArch !== e.arch;
              const macMismatch =
                e.os === "macos" &&
                selectedHost &&
                !["macos", "apple"].includes(selectedHost.provider);
              const windowsMismatch =
                e.os === "windows" &&
                selectedHost &&
                !(
                  selectedHost.provider === "hyperv" ||
                  selectedHost.provider === "libvirt" ||
                  selectedHost.runtimes?.some((r) =>
                    ["hyperv", "libvirt"].includes(r),
                  )
                );
              const linuxMismatch =
                e.os === "linux" &&
                selectedHost &&
                !(
                  ["apple", "libvirt"].includes(selectedHost.provider) ||
                  selectedHost.runtimes?.some((r) =>
                    ["apple", "libvirt"].includes(r),
                  )
                );
              const reason = mismatch
                ? "Host architecture does not match this image."
                : macMismatch
                  ? "macOS requires an Apple silicon Mac."
                  : windowsMismatch
                    ? "This host has no Windows VM runtime."
                    : linuxMismatch
                      ? "This host has no Linux VM runtime."
                      : "";
              return (
                <article
                  key={e.id}
                  aria-label={e.name + " " + e.arch}
                  className="flex min-w-0 flex-col gap-3 rounded-md border p-4"
                >
                  <div className="space-y-2">
                    <p className="text-[10px] text-muted-foreground">
                      {e.publisher}
                    </p>
                    <h3 className="break-words text-sm font-medium">
                      {e.name}
                    </h3>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">
                        {e.arch === "amd64" ? "x86-64" : "ARM64"}
                      </Badge>
                      <Badge variant="outline">
                        {e.mediaType === "installer"
                          ? "Installer"
                          : "Boot disk"}
                      </Badge>
                      <Badge variant="outline">{e.format.toUpperCase()}</Badge>
                      {e.status !== "available" && (
                        <Badge variant="outline">
                          {e.status === "unavailable"
                            ? "Not currently offered"
                            : "Publisher download"}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <p className="break-words text-xs leading-relaxed text-muted-foreground">
                    {e.note}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Starting size: {e.minimum.cpu} vCPU ·{" "}
                    {memory(e.minimum.memoryMiB)} · {e.minimum.diskGiB} GiB disk
                  </p>
                  {reason && (
                    <p className="text-[10px] text-muted-foreground">
                      {reason}
                    </p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    {e.resolver ? (
                      <Button
                        size="sm"
                        disabled={busy || pending || !host || !!reason}
                        onClick={() => importEntry(e)}
                      >
                        <Download />
                        Import to host
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onImportFile(e)}
                      >
                        Import downloaded file
                      </Button>
                    )}
                    <a
                      href={e.sourcePage}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4"
                    >
                      Official source
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <div className="flex justify-end border-t pt-3">
          <Button variant="outline" onClick={onClose}>
            {pending ? "Continue in background" : "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
