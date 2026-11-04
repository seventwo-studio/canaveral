import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  imageTask,
  imageTasks,
  importedImage,
  resourceFields,
} from "@/lib/catalogue";
import type {
  CatalogueHost,
  ImageTask,
  Refresh,
  RegistryEntry,
  ResourceInput,
} from "@/lib/catalogue";
import { record } from "@/lib/types";
import { Upload, Camera } from "lucide-react";
import { api, errorMessage, since, provider } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function ImageImport({
  hosts,
  onClose,
  onRefresh,
  preset = null,
}: {
  hosts: CatalogueHost[];
  onClose: () => void;
  onRefresh: Refresh;
  preset?: RegistryEntry | null;
}) {
  const candidates = hosts.filter(
    (h) => h.kind !== "orchestrator" && h.provider !== "kubevirt" && h.online,
  );
  const [host, setHost] = useState(candidates[0]?.id || ""),
    [name, setName] = useState(preset?.name || ""),
    [os, setOs] = useState(preset?.os || "linux"),
    [arch, setArch] = useState(preset?.arch || "arm64"),
    [media, setMedia] = useState(preset?.mediaType || "disk"),
    [format, setFormat] = useState(preset?.format || "qcow2"),
    [file, setFile] = useState<File | null>(null),
    [guest, setGuest] = useState(false),
    [size, setSize] = useState<ResourceInput>(
      preset?.minimum || { cpu: 2, memoryMiB: 4096, diskGiB: 32 },
    ),
    [progress, setProgress] = useState<number | null>(null),
    [result, setResult] = useState<{ name: string; sha256: string } | null>(
      null,
    ),
    [error, setError] = useState("");
  const request = useRef<XMLHttpRequest | null>(null),
    intent = useRef<{ id: string; fingerprint: string } | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  const busy = progress !== null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setError("");
    setProgress(0);
    const metadata = {
      id: "",
      name,
      os,
      arch,
      mode: "desktop",
      mediaType: media,
      format,
      minimum: size,
      ...(guest && os === "linux" && media === "disk"
        ? { guestAccess: true }
        : {}),
    };
    const fingerprint = JSON.stringify({
      host,
      metadata,
      file: [file.name, file.size, file.lastModified],
    });
    if (!intent.current || intent.current.fingerprint !== fingerprint)
      intent.current = { id: crypto.randomUUID(), fingerprint };
    metadata.id = intent.current.id;
    try {
      const imported = await new Promise<{ name: string; sha256: string }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          request.current = xhr;
          xhr.open("POST", `/api/v1/hosts/${host}/images/import`);
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          xhr.setRequestHeader(
            "X-Canaveral-Image",
            encodeURIComponent(JSON.stringify(metadata)),
          );
          xhr.upload.onprogress = (e) => {
            if (alive.current && e.lengthComputable)
              setProgress(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            try {
              const value: unknown = JSON.parse(xhr.responseText);
              if (xhr.status >= 200 && xhr.status < 300)
                resolve(importedImage(value, metadata.id, file.size));
              else {
                const detail = record(value).error;
                reject(
                  new Error(
                    typeof detail === "string"
                      ? detail
                      : "Image import failed.",
                  ),
                );
              }
            } catch {
              reject(
                new Error(
                  "Import response was interrupted. Inspect the image task before retrying.",
                ),
              );
              return;
            }
          };
          xhr.onerror = () =>
            reject(
              new Error(
                "Import connection ended. Inspect the image task before retrying.",
              ),
            );
          xhr.onabort = () =>
            reject(
              new Error(
                "Upload cancelled. Its task reports whether host cleanup completed.",
              ),
            );
          xhr.send(file);
        },
      );
      if (alive.current) {
        setResult(imported);
        await onRefresh();
      }
    } catch (e) {
      if (alive.current) setError(`${errorMessage(e)} Task ${metadata.id}.`);
    } finally {
      if (alive.current) setProgress(null);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import base image</DialogTitle>
          <DialogDescription>
            Upload installation media or an installed boot disk to a host. The
            artifact is immutable and consumes its storage budget.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="break-all text-xs text-destructive">
            {error}
          </p>
        )}
        {result ? (
          <div className="space-y-3">
            <p className="text-sm">Imported {result.name}.</p>
            <p className="break-all text-xs text-muted-foreground">
              SHA-256 {result.sha256}
            </p>
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <fieldset disabled={busy} className="space-y-4">
              <label className="block space-y-2 text-xs">
                Image name
                <Input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block space-y-2 text-xs">
                Destination host
                <select
                  aria-label="Destination host"
                  required
                  className="h-9 w-full rounded-md border bg-background px-2"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                >
                  {candidates.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} · {provider(h.platform || h.provider)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["Guest OS", os, setOs, ["linux", "windows", "macos"]],
                    ["Architecture", arch, setArch, ["arm64", "amd64"]],
                  ] satisfies Array<
                    [string, string, (value: string) => void, string[]]
                  >
                ).map(([label, value, set, options]) => (
                  <label key={label} className="space-y-2 text-xs">
                    {label}
                    <select
                      aria-label={label}
                      className="h-9 w-full rounded-md border bg-background px-2"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                    >
                      {options.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-2 text-xs">
                  Media type
                  <select
                    aria-label="Media type"
                    className="h-9 w-full rounded-md border bg-background px-2"
                    value={media}
                    onChange={(e) => {
                      setMedia(
                        e.target.value === "installer" ? "installer" : "disk",
                      );
                      setFormat(
                        e.target.value === "installer" ? "iso" : "qcow2",
                      );
                    }}
                  >
                    <option value="disk">Installed boot disk</option>
                    <option value="installer">OS installer</option>
                  </select>
                </label>
                <label className="space-y-2 text-xs">
                  Format
                  <select
                    aria-label="Format"
                    className="h-9 w-full rounded-md border bg-background px-2"
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    {(media === "disk"
                      ? ["qcow2", "raw", "vhdx"]
                      : ["iso", "ipsw"]
                    ).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {resourceFields.map(([key, label]) => (
                  <label key={key} className="space-y-2 text-xs">
                    {label}
                    <Input
                      type="number"
                      min="1"
                      max="1048576"
                      required
                      value={size[key]}
                      onChange={(e) =>
                        setSize({
                          ...size,
                          [key]:
                            e.target.value === "" ? "" : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              {os === "linux" && media === "disk" && (
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={guest}
                    onChange={(e) => setGuest(e.target.checked)}
                  />
                  <span>
                    Prepare Linux desktop access with cloud-init
                    <p className="mt-1 text-muted-foreground">
                      Requires a compatible Ubuntu/Debian cloud image and a
                      configured host guest-access identity.
                    </p>
                  </span>
                </label>
              )}
              <label className="block space-y-2 text-xs">
                Image file
                <Input
                  type="file"
                  aria-label="Image file"
                  required
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Installer interaction requires the runtime’s console. Imported
                media is not evidence of a successfully installed OS.
              </p>
            </fieldset>
            {busy ? (
              <div className="space-y-2">
                <progress
                  max="100"
                  value={progress}
                  className="w-full"
                  aria-label="Image upload progress"
                />
                <p className="text-xs text-muted-foreground">
                  {progress < 100
                    ? `Uploading ${progress}%`
                    : "Verifying and registering image…"}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => request.current?.abort()}
                >
                  Cancel upload
                </Button>
              </div>
            ) : (
              <Button type="submit" disabled={!candidates.length || !file}>
                <Upload />
                Import image
              </Button>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ImageCapture({
  machine,
  onClose,
  onRefresh,
}: {
  machine: { id: string; name: string; desired: string; observed: string };
  onClose: () => void;
  onRefresh: Refresh;
}) {
  const [name, setName] = useState(`${machine.name} image`),
    [task, setTask] = useState<ImageTask | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const intent = useRef<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!task || ["succeeded", "failed", "unknown"].includes(task.state))
      return;
    const taskId = task.id;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api(`image-tasks/${taskId}`, undefined, (value) =>
          imageTask(value, taskId),
        );
        if (stopped) return;
        setTask(value);
        if (value.state === "succeeded") await onRefresh();
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    }
    timer = setTimeout(poll, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [task?.id, task?.state]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    if (!intent.current || intent.current.name !== name)
      intent.current = { id: crypto.randomUUID(), name };
    const taskId = intent.current.id;
    try {
      setTask(
        await api(
          "images/captures",
          {
            id: taskId,
            machineId: machine.id,
            name,
          },
          (value) => imageTask(value, taskId),
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Capture configured VM</DialogTitle>
          <DialogDescription>
            Save {machine.name} as a reusable disk image. The source remains
            stopped while its disk is copied and verified.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {task ? (
          <div className="space-y-3">
            <p className="text-sm">
              {task.state === "succeeded"
                ? "Image captured"
                : task.state === "failed"
                  ? "Capture failed"
                  : task.state === "unknown"
                    ? "Capture needs recovery"
                    : "Capturing and verifying disk…"}
            </p>
            <p className="break-all text-xs text-muted-foreground">
              Task {task.id}
            </p>
            {task.result?.detail && (
              <p className="text-xs text-muted-foreground">
                {task.result.detail}
              </p>
            )}
            {task.result?.consistency && (
              <p className="text-xs text-muted-foreground">
                Capture consistency: {task.result.consistency}. Only committed
                disk state is preserved.
              </p>
            )}
            <Button onClick={onClose}>
              {["queued", "running"].includes(task.state)
                ? "Continue in background"
                : "Done"}
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <label className="block space-y-2 text-xs">
              Image name
              <Input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The image preserves configured OS data. Fresh access and guest
              identity require supported per-instance preparation; this is a
              cold disk capture, without running memory.
            </p>
            <Button
              disabled={
                busy ||
                machine.desired !== "stopped" ||
                machine.observed !== "stopped"
              }
            >
              <Camera />
              Capture image
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ImageActivity(_props: { onRefresh: Refresh }) {
  const [tasks, setTasks] = useState<ImageTask[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const value = await api("image-tasks", undefined, imageTasks);
        if (!stopped) {
          setTasks(value);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
    }
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  if (!tasks.length && !error) return null;
  return (
    <section
      className="space-y-2 rounded-md border p-4"
      aria-label="Image activity"
    >
      <h2 className="text-sm font-medium">Image activity</h2>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {tasks.slice(0, 8).map((task) => (
        <div
          key={task.id}
          className="flex flex-wrap justify-between gap-2 border-t pt-2 text-xs"
        >
          <span className="break-all">
            {task.name} · {task.kind}
          </span>
          <span className="text-muted-foreground">
            {task.state} · {since(task.updatedAt)}
          </span>
          {task.result?.detail && (
            <p className="w-full text-muted-foreground">{task.result.detail}</p>
          )}
        </div>
      ))}
    </section>
  );
}
