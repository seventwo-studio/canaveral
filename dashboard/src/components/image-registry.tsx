import { Card } from "./ui/card";
import { NativeSelect } from "./ui/native-select";
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
import { Badge, StatusBadge } from "./ui/badge";
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
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null),
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
  const visible = (entries ?? []).filter(
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
            Download original OS images to your library. Use a machine blueprint
            for resource presets and prepared snapshots.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-[13px] font-medium">
            Import onto host
            <NativeSelect
              aria-label="Registry target host"

              value={host}
              onChange={(e) => setHost(e.target.value)}
            >
              <option value="">Select a host</option>
              {candidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid min-w-0 gap-1.5 text-[13px] font-medium">
            Search registry
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ubuntu, macOS, Windows…"
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-[13px] font-medium">
            Operating system
            <NativeSelect value={os} onChange={(e) => setOs(e.target.value)}>
              <option value="all">All operating systems</option>
              <option value="linux">Linux</option>
              <option value="macos">macOS</option>
              <option value="windows">Windows</option>
            </NativeSelect>
          </label>
          <label className="grid min-w-0 gap-1.5 text-[13px] font-medium">
            Architecture
            <NativeSelect
              value={arch}
              onChange={(e) => setArch(e.target.value)}
            >
              <option value="all">All architectures</option>
              <option value="arm64">ARM64</option>
              <option value="amd64">x86-64</option>
            </NativeSelect>
          </label>
        </div>
        {error && (
          <p role="alert" className="break-words text-xs text-destructive">
            {error}
          </p>
        )}
        {task && (
          <Card asChild className="gap-2 px-4 text-xs">
            <section aria-label="Registry import status" aria-live="polite">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {task.name} <StatusBadge state={task.state} />
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
          </Card>
        )}
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading registry…</p>
        ) : !entries ? null : !visible.length ? (
          <p className="text-xs text-muted-foreground">
            {entries.length
              ? "No images match these filters."
              : "No images are available in the registry."}
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
                <Card asChild key={e.id} className="gap-3 px-4">
                  <article aria-label={e.name + " " + e.arch}>
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {e.publisher}
                      </p>
                      <h3 className="break-words text-sm font-medium">
                        {e.name}
                      </h3>
                      <div className="flex flex-wrap gap-1">
                        <Badge>{e.arch === "amd64" ? "x86-64" : "ARM64"}</Badge>
                        <Badge>
                          {e.mediaType === "installer"
                            ? "Installer"
                            : "Boot disk"}
                        </Badge>
                        <Badge>{e.format.toUpperCase()}</Badge>
                        {e.status !== "available" && (
                          <Badge>
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
                    <p className="text-xs text-muted-foreground">
                      {e.resolver === "apple"
                        ? "Apple restore source; local content hash recorded after download."
                        : e.resolver
                          ? "Publisher SHA-256 required before adding to the library."
                          : "Verify the download with the publisher before importing."}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Starting size: {e.minimum.cpu} vCPU ·{" "}
                      {memory(e.minimum.memoryMiB)} · {e.minimum.diskGiB} GiB
                      disk
                    </p>
                    {reason && (
                      <p className="text-xs text-muted-foreground">{reason}</p>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
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
                          disabled={e.status === "unavailable"}
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
                </Card>
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
