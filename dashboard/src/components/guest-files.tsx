import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Download,
  Upload,
  Folder,
  File,
  RefreshCw,
  X,
  ChevronRight,
  Home,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operate } from "@/lib/machine-operations";
import { errorMessage } from "@/lib/api";
import { fileListing, pulledFile, uploadReceipt } from "@/lib/workspace";
import type { FileEntry, WorkspaceMachine } from "@/lib/workspace";

const bytes = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
function size(value?: number | null) {
  return value == null
    ? "—"
    : value < 1024
      ? `${value} B`
      : value < 1048576
        ? `${(value / 1024).toFixed(1)} KiB`
        : `${(value / 1048576).toFixed(1)} MiB`;
}
export function GuestFiles({
  machine,
}: {
  machine: Pick<WorkspaceMachine, "id" | "template">;
}) {
  const ios = machine.template.os === "ios",
    linux = machine.template.os === "linux";
  const initial = ios
    ? "."
    : linux
      ? machine.template.mode === "headless"
        ? "/"
        : "/home/desktop"
      : "/sdcard";
  const [path, setPath] = useState(initial),
    [draft, setDraft] = useState(initial),
    [app, setApp] = useState(""),
    [entries, setEntries] = useState<FileEntry[]>([]),
    [selected, setSelected] = useState<FileEntry | null>(null),
    [preview, setPreview] = useState<{
      data: Uint8Array | null;
      text: string | null;
    } | null>(null),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("");
  const request = useRef<XMLHttpRequest | null>(null);
  const [uploading, setUploading] = useState<{
    name: string;
    loaded: number;
    total: number;
  } | null>(null);
  const upload = useRef<HTMLInputElement>(null),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      request.current?.abort();
    },
    [],
  );
  const args = (target: string) => ({ path: target, ...(ios ? { app } : {}) });
  const child = (name: string) => `${path.replace(/\/$/, "")}/${name}`;
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function browse(target = path) {
    const result = fileListing(
      await operate(machine.id, "list-files", args(target)),
    );
    if (!alive.current) return;
    setPath(result.path || target);
    setDraft(result.path || target);
    setEntries(
      result.entries.sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
          a.name.localeCompare(b.name),
      ),
    );
    setLoaded(true);
    setSelected(null);
    setPreview(null);
    if (result.truncated) setError("Showing the first 2,000 entries.");
  }
  useEffect(() => {
    if (!ios) action(() => browse(initial));
  }, [machine.id]);
  async function inspect(entry: FileEntry) {
    if (entry.kind === "directory") {
      await browse(child(entry.name));
      return;
    }
    setSelected(entry);
    setPreview(null);
    if ((entry.size ?? 0) > 1048576) {
      setPreview({ data: null, text: null });
      return;
    }
    const result = pulledFile(
      await operate(machine.id, "pull", args(child(entry.name))),
    );
    const data = bytes(result.data);
    let text: string | null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (/[\x00-\x08\x0e-\x1f]/.test(text)) text = null;
    } catch {
      text = null;
    }
    setPreview({ data, text });
  }
  function download() {
    if (!selected) return;
    const payload = encodeURIComponent(
      JSON.stringify(args(child(selected.name))),
    ).replace(/%([0-9A-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    const encoded = btoa(payload)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const link = document.createElement("a");
    link.href = `/api/v1/machines/${machine.id}/files/download/${encoded}`;
    link.download = selected.name;
    link.click();
  }
  function streamUpload(file: globalThis.File) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      request.current = xhr;
      setUploading({ name: file.name, loaded: 0, total: file.size });
      xhr.open("POST", `/api/v1/machines/${machine.id}/files/upload`);
      xhr.withCredentials = true;
      xhr.responseType = "json";
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader(
        "X-Canaveral-Path",
        encodeURIComponent(child(file.name)),
      );
      if (ios) xhr.setRequestHeader("X-Canaveral-App", app);
      const end = () => {
        request.current = null;
        if (alive.current) setUploading(null);
      };
      xhr.upload.onprogress = (event) => {
        if (alive.current)
          setUploading({
            name: file.name,
            loaded: event.loaded,
            total: file.size,
          });
      };
      xhr.onload = () => {
        end();
        const response: unknown = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            uploadReceipt(response, file.size);
            resolve();
          } catch (error) {
            reject(error);
          }
        } else
          reject(
            new Error(
              (response !== null &&
              typeof response === "object" &&
              "error" in response &&
              typeof response.error === "string"
                ? response.error
                : undefined) ||
                "Upload failed. Inspect the destination before retrying.",
            ),
          );
      };
      xhr.onerror = () => {
        end();
        reject(
          new Error(
            "Upload interrupted. Inspect the destination before retrying.",
          ),
        );
      };
      xhr.onabort = () => {
        end();
        reject(new Error("Upload cancelled."));
      };
      xhr.send(file);
    });
  }
  const visible = entries.filter((e) =>
    e.name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Guest file browser"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Parent directory"
          disabled={busy}
          onClick={() =>
            action(() =>
              browse(
                path.split("/").slice(0, -1).join("/") || (ios ? "." : "/"),
              ),
            )
          }
        >
          <ArrowUp />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Home directory"
          disabled={busy}
          onClick={() => action(() => browse(initial))}
        >
          <Home />
        </Button>
        <form
          className="flex min-w-40 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            action(() => browse(draft));
          }}
        >
          <Input
            aria-label="Directory path"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button variant="outline" disabled={busy || (ios && !app)}>
            Browse
          </Button>
        </form>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh directory"
          disabled={busy || !loaded}
          onClick={() => action(() => browse())}
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !loaded}
          onClick={() => upload.current?.click()}
        >
          <Upload />
          Upload
        </Button>
        <input
          ref={upload}
          type="file"
          className="hidden"
          aria-label="Upload file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            action(async () => {
              await streamUpload(file);
              await browse();
            });
          }}
        />
      </div>
      {ios && (
        <div className="border-b p-3">
          <label className="mb-2 block text-xs" htmlFor="file-app">
            App bundle ID
          </label>
          <Input
            id="file-app"
            placeholder="com.example.app"
            value={app}
            onChange={(e) => {
              setApp(e.target.value);
              setLoaded(false);
            }}
          />
        </div>
      )}
      {uploading && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2 text-xs"
          role="status"
        >
          <span className="min-w-0 flex-1 break-all">
            Uploading {uploading.name} · {size(uploading.loaded)} /{" "}
            {size(uploading.total)}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => request.current?.abort()}
          >
            Cancel upload
          </Button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="break-words border-b p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {loaded ? `${visible.length} items` : "Choose a directory"}
            </span>
            <Input
              className="w-full sm:w-56"
              aria-label="Filter files"
              placeholder="Filter files…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3 border-b bg-muted/30 px-4 py-2 text-[10px] uppercase text-muted-foreground sm:grid-cols-[minmax(0,1fr)_5rem_9rem]">
              <span>Name</span>
              <span>Size</span>
              <span className="hidden sm:block">Modified</span>
            </div>
            {visible.map((entry) => (
              <button
                key={entry.name}
                disabled={busy}
                onClick={() => action(() => inspect(entry))}
                className={`grid w-full grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 border-b px-4 py-3 text-left text-xs hover:bg-muted sm:grid-cols-[minmax(0,1fr)_5rem_9rem] ${selected?.name === entry.name ? "bg-muted" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  {entry.kind === "directory" ? (
                    <Folder className="size-4 shrink-0 text-primary" />
                  ) : (
                    <File className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 break-all">{entry.name}</span>
                </span>
                <span className="text-muted-foreground">
                  {entry.kind === "directory" ? "Folder" : size(entry.size)}
                </span>
                <span className="hidden text-muted-foreground sm:block">
                  {entry.modifiedAt
                    ? new Date(entry.modifiedAt * 1000).toLocaleString()
                    : "—"}
                </span>
              </button>
            ))}
            {!visible.length && (
              <div className="flex flex-col items-center gap-3 p-12 text-center text-muted-foreground">
                <Folder className="size-8" />
                <p className="text-sm">
                  {busy
                    ? "Loading files…"
                    : !loaded
                      ? "Browse a guest directory"
                      : filter
                        ? "No matching files"
                        : "This directory is empty"}
                </p>
              </div>
            )}
          </div>
        </div>
        {selected && (
          <section
            className="flex min-h-48 min-w-0 flex-col border-t md:w-[42%] md:border-l md:border-t-0"
            aria-label="File preview"
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b p-3">
              <span className="min-w-0 break-all text-xs font-medium">
                {selected.name}
              </span>
              <div className="flex gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Download selected file"
                  disabled={!selected}
                  onClick={download}
                >
                  <Download />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close file preview"
                  onClick={() => {
                    setSelected(null);
                    setPreview(null);
                  }}
                >
                  <X />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {!preview ? (
                <p className="text-xs text-muted-foreground">
                  Loading preview…
                </p>
              ) : preview.text === null ? (
                <p className="text-xs text-muted-foreground">
                  Preview not shown ·{" "}
                  {size(preview.data?.length ?? selected.size)}. Download to
                  open.
                </p>
              ) : (
                <pre className="whitespace-pre-wrap break-all text-xs leading-relaxed">
                  {preview.text}
                </pre>
              )}
            </div>
          </section>
        )}
      </div>
      <footer className="shrink-0 border-t px-4 py-2 text-[10px] text-muted-foreground">
        Guest filesystem · Uploading replaces a file with the same name
      </footer>
    </div>
  );
}
