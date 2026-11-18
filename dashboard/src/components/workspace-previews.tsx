import { readFile } from "@/lib/workspace-file";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { record } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const states = [
  "provisioning",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
];
function preview(value: unknown, expected?: string) {
  const p = record(value);
  if (
    typeof p.id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.id) ||
    (expected && p.id !== expected) ||
    (p.mode !== "static" && p.mode !== "command") ||
    typeof p.state !== "string" ||
    !states.includes(p.state) ||
    typeof p.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(p.expiresAt))
  )
    throw new Error("Invalid preview response.");
  return { id: p.id, mode: p.mode, state: p.state, expiresAt: p.expiresAt };
}
type Preview = ReturnType<typeof preview>;
type Launch = {
  id: string;
  mode: string;
  files: { path: string; data: string }[];
  argv?: string[];
  port?: number;
};

export function WorkspacePreviews() {
  const [rows, setRows] = useState<Preview[]>([]);
  const [mode, setMode] = useState("static");
  const [files, setFiles] = useState<File[]>([]);
  const [argv, setArgv] = useState("");
  const [port, setPort] = useState("3000");
  const [pending, setPending] = useState<Launch>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const list = await api("previews", undefined, (v) => {
          const items = record(v).previews;
          if (!Array.isArray(items)) throw new Error("Invalid preview list.");
          return items.map((p) => preview(p));
        });
        if (active) {
          setRows(list);
          setLoaded(true);
          setLoadError("");
          if (
            list.some((p) =>
              ["starting", "provisioning", "stopping"].includes(p.state),
            )
          )
            timer = setTimeout(load, 3000);
        }
      } catch (e) {
        if (active) setLoadError(errorMessage(e));
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh, busy]);

  async function act(
    action: "launch" | "inspect" | "release" | "open",
    id?: string,
  ) {
    setBusy(true);
    setError("");
    try {
      if (action === "open") {
        const { handoffUrl } = record(
          await api("previews/" + id + "/open", {}),
        );
        if (typeof handoffUrl !== "string")
          throw new Error("Invalid preview handoff.");
        const url = new URL(handoffUrl);
        if (
          url.protocol !== "https:" ||
          url.hostname === location.hostname ||
          url.username ||
          url.password
        )
          throw new Error("Invalid preview handoff.");
        window.location.assign(url.href);
        return;
      }
      let item: Preview;
      if (action === "launch") {
        let body = pending;
        if (!body) {
          if (!files.length) throw new Error("Choose workspace files.");
          const args = argv.split(/\r?\n/);
          if (
            mode === "command" &&
            (!args[0]?.trim() ||
              !Number.isInteger(Number(port)) ||
              Number(port) < 1 ||
              Number(port) > 65535)
          )
            throw new Error(
              "Enter a foreground command and a port from 1 to 65535.",
            );
          // The dashboard accepts at most 1 MiB of JSON per mutation.
          const encodedBytes = files.reduce(
            (sum, file) => sum + 4 * Math.ceil(file.size / 3),
            0,
          );
          if (encodedBytes > 1048576)
            throw new Error(
              "The selected files exceed the dashboard’s 1 MiB request limit.",
            );
          const entries = await Promise.all(files.map(readFile));
          if (
            mode === "static" &&
            !entries.some((f) => f.path === "index.html")
          )
            throw new Error(
              "The selected directory needs an index.html at its root.",
            );
          body = {
            id: crypto.randomUUID(),
            mode,
            files: entries,
            ...(mode === "command" ? { argv: args, port: Number(port) } : {}),
          };
          if (new Blob([JSON.stringify(body)]).size > 1048576)
            throw new Error(
              "The selected files exceed the dashboard’s 1 MiB request limit.",
            );
          setPending(body);
        }
        const launchId = body.id;
        item = await api("previews", body, (v) => preview(v, launchId));
        setPending(undefined);
      } else {
        item = await api(
          "previews/" + id,
          undefined,
          (v) => preview(v, id),
          action === "release" ? "DELETE" : undefined,
        );
      }
      setRows((prev) => [item, ...prev.filter((p) => p.id !== item.id)]);
    } catch (e) {
      setError(errorMessage(e));
      if (
        action === "launch" &&
        e instanceof Error &&
        "status" in e &&
        typeof e.status === "number" &&
        [400, 413, 422].includes(e.status) &&
        !("outcome" in e)
      )
        setPending(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6">
      <h1 className="font-display text-3xl">Workspace previews</h1>
      <form
        className="space-y-4 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void act("launch");
        }}
      >
        <p>New previews use the operator-configured pinned image.</p>
        <fieldset disabled={busy || !!pending} className="grid gap-3">
          <label>
            Preview type{" "}
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setFiles([]);
              }}
            >
              <option value="static">Static site</option>
              <option value="command">Dynamic app</option>
            </select>
          </label>
          <label>
            Workspace directory
            <Input
              key={mode}
              type="file"
              multiple
              {...{ webkitdirectory: "" }}
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
          </label>
          {files.length > 0 && <p>{files.length} files selected</p>}
          {mode === "command" && (
            <>
              <label>
                Foreground command and arguments (one per line)
                <Textarea
                  required
                  value={argv}
                  onChange={(e) => setArgv(e.target.value)}
                />
              </label>
              <label>
                HTTP port
                <Input
                  type="number"
                  min="1"
                  max="65535"
                  required
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </label>
            </>
          )}
        </fieldset>
        {pending && (
          <p>
            Launch request <code>{pending.id}</code>
          </p>
        )}
        <Button disabled={busy}>
          {pending ? "Retry same launch" : "Launch preview"}
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <h2 className="text-xl">Your previews</h2>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => setRefresh((v) => v + 1)}
      >
        Refresh previews
      </Button>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !rows.length && (
        <p role="status">{loaded ? "No previews yet." : "Loading previews…"}</p>
      )}
      <ul aria-live="polite" className="space-y-3">
        {rows.map((p) => (
          <li key={p.id} className="space-y-2 rounded-lg border p-4">
            <p>
              {p.mode === "command" ? "Dynamic app" : "Static site"} · {p.state}
            </p>
            <code>{p.id}</code>
            <p>
              Expires{" "}
              <time dateTime={p.expiresAt}>
                {new Date(p.expiresAt).toLocaleString()}
              </time>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act("inspect", p.id)}
              >
                Inspect
              </Button>
              {p.state === "ready" && (
                <Button
                  disabled={busy || Date.parse(p.expiresAt) <= Date.now()}
                  onClick={() => void act("open", p.id)}
                >
                  Open preview
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy || ["stopping", "stopped"].includes(p.state)}
                onClick={() => void act("release", p.id)}
              >
                Release
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
