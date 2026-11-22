import { SettingsRows } from "./ui/field";
import { NativeSelect } from "./ui/native-select";
import { Empty, EmptyDescription } from "./ui/empty";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { record } from "@/lib/types";
import { readFile } from "@/lib/workspace-file";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const activeStates = ["provisioning", "running", "stopping"];
function build(value: unknown, expected?: string) {
  const { id, imageId, artifact, state, result } = record(value);
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
    (expected && id !== expected) ||
    typeof imageId !== "string" ||
    typeof artifact !== "string" ||
    typeof state !== "string" ||
    ![...activeStates, "succeeded", "failed", "stopped"].includes(state)
  )
    throw Error("Invalid build response.");
  return {
    id,
    imageId,
    artifact,
    state,
    result: result ? record(result) : undefined,
  };
}
function output(data: unknown) {
  if (typeof data !== "string") return "";
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    );
  } catch {
    return "Invalid output encoding.";
  }
}
type Build = ReturnType<typeof build>;
type Launch = {
  id: string;
  imageId: string;
  artifact: string;
  argv: string[];
  files: Awaited<ReturnType<typeof readFile>>[];
};
function BuildRow({ initial }: { initial: Build }) {
  const [row, setRow] = useState(initial);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (busy) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function inspect() {
      try {
        const next = await api("builds/" + initial.id, undefined, (v) =>
          build(v, initial.id),
        );
        if (!live) return;
        setRow(next);
        setError("");
        if (activeStates.includes(next.state))
          timer = setTimeout(inspect, 3000);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    }
    void inspect();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [initial, refresh, busy]);
  async function cancel() {
    setBusy(true);
    try {
      setRow(
        await api(
          "builds/" + row.id,
          undefined,
          (v) => build(v, row.id),
          "DELETE",
        ),
      );
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="min-w-0 space-y-2 px-3 py-3 text-[13px]">
      <h3 className="break-all text-sm font-semibold">{row.artifact}</h3>
      <p className="break-all font-mono text-xs text-muted-foreground">
        {row.imageId} · {row.id}
      </p>
      <p role="status">{row.state}</p>
      {row.result && (
        <>
          <p>
            {row.result.timedOut
              ? "Timed out"
              : row.result.signal
                ? "Signal " + String(row.result.signal)
                : "Exit code " + String(row.result.exitCode ?? "unknown")}
            {row.result.truncated ? " · Output truncated" : ""}
          </p>
          <h4>Standard output</h4>
          <pre className="overflow-auto rounded-sm bg-muted p-3 font-mono text-xs">
            {output(row.result.stdoutBase64)}
          </pre>
          <h4>Standard error</h4>
          <pre className="overflow-auto rounded-sm bg-muted p-3 font-mono text-xs">
            {output(row.result.stderrBase64)}
          </pre>
        </>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {error && (
          <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
            Refresh status
          </Button>
        )}
        {["provisioning", "running"].includes(row.state) && (
          <Button disabled={busy} variant="outline" onClick={cancel}>
            Cancel build
          </Button>
        )}
        {row.state === "succeeded" && (
          <Button asChild>
            <a href={"/api/v1/builds/" + row.id + "/artifact"} download>
              Download verified artifact
            </a>
          </Button>
        )}
      </div>
    </article>
  );
}
export function WorkspaceBuilds() {
  const [images, setImages] = useState<{ id: string; label: string }[]>([]);
  const [imageId, setImageId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [argv, setArgv] = useState("");
  const [artifact, setArtifact] = useState("");
  const [rows, setRows] = useState<Build[]>();
  const [pending, setPending] = useState<Launch>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imageError, setImageError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    void api("builds/images", undefined, (v) => {
      const items = record(v).images;
      if (!Array.isArray(items)) throw Error("Invalid build images.");
      return items.map((item) => {
        const { id, templateId, templateRevision, arch, digest } = record(item);
        if (
          typeof id !== "string" ||
          !id ||
          ![templateId, templateRevision, arch, digest].every(
            (x) => typeof x === "string",
          )
        )
          throw Error("Invalid build image.");
        return {
          id,
          label: [id, templateId, templateRevision, arch, digest].join(" · "),
        };
      });
    })
      .then((pins) => {
        if (!live) return;
        setImages(pins);
        setImageId((prev) =>
          pins.some((p) => p.id === prev) ? prev : (pins[0]?.id ?? ""),
        );
        setImageError("");
      })
      .catch((e) => {
        if (!live) return;
        setImages([]);
        setImageId("");
        setImageError(errorMessage(e));
      });
    void api("builds", undefined, (v) => {
      const items = record(v).builds;
      if (!Array.isArray(items)) throw Error("Invalid build list.");
      return items.map((item) => build(item));
    })
      .then((list) => {
        if (!live) return;
        setRows(list);
        setLoadError("");
      })
      .catch((e) => {
        if (live) setLoadError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [refresh]);
  async function launch() {
    setBusy(true);
    setError("");
    try {
      let body = pending;
      if (!body) {
        if (
          !imageId ||
          !files.length ||
          !argv.split(/\r?\n/)[0]?.trim() ||
          !artifact.trim() ||
          artifact.split("/").some((x) => !x || x === "." || x === "..")
        )
          throw Error(
            "Choose a directory and image, enter an executable and a workspace-relative artifact path.",
          );
        if (
          files.length > 128 ||
          files.reduce((sum, f) => sum + 4 * Math.ceil(f.size / 3), 0) > 1048576
        )
          throw Error("Source exceeds the 128-file or 1 MiB request limit.");
        body = {
          id: crypto.randomUUID(),
          imageId,
          artifact,
          argv: argv.split(/\r?\n/),
          files: await Promise.all(files.map(readFile)),
        };
        if (new Blob([JSON.stringify(body)]).size > 1048576)
          throw Error("Source exceeds the 1 MiB request limit.");
        setPending(body);
      }
      const id = body.id;
      const next = await api("builds", body, (v) => build(v, id));
      setRows((prev) => [next, ...(prev ?? []).filter((row) => row.id !== id)]);
      setPending(undefined);
    } catch (e) {
      setError(errorMessage(e));
      if (
        e instanceof Error &&
        "status" in e &&
        [400, 413, 422].includes(Number(e.status)) &&
        !("outcome" in e)
      )
        setPending(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0 space-y-5 text-sm">
      <form
        className="max-w-2xl space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void launch();
        }}
      >
        <fieldset className="min-w-0" disabled={busy || !!pending}>
          <SettingsRows>
            <label className="text-[13px] font-medium">
              Source directory
              <Input
                type="file"
                multiple
                {...{ webkitdirectory: "" }}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <label className="text-[13px] font-medium">
              Approved workspace image
              <NativeSelect
                value={imageId}
                onChange={(e) => setImageId(e.target.value)}
              >
                {images.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="text-[13px] font-medium">
              Command (one argument per line)
              <Textarea
                value={argv}
                onChange={(e) => setArgv(e.target.value)}
              />
            </label>
            <label className="text-[13px] font-medium">
              Artifact path
              <Input
                placeholder="dist/package.tar"
                value={artifact}
                onChange={(e) => setArtifact(e.target.value)}
              />
            </label>
          </SettingsRows>
        </fieldset>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {pending && (
          <p>
            Launch request <code>{pending.id}</code>
          </p>
        )}
        <Button
          className="ml-auto flex"
          disabled={busy || (!pending && !imageId)}
        >
          {pending ? "Retry same launch" : "Launch build"}
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">Your builds</h2>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh builds
        </Button>
      </div>
      {imageError && (
        <p className="text-sm text-destructive" role="alert">
          Build images unavailable: {imageError}
        </p>
      )}
      {loadError && (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      )}
      <div className="divide-y border-y empty:hidden">
        {rows?.map((row) => (
          <BuildRow key={row.id} initial={row} />
        ))}
      </div>
      {!rows?.length && !loadError && (
        <Empty showIcon={!!rows} role="status">
          <EmptyDescription>
            {rows ? "No builds yet." : "Loading builds…"}
          </EmptyDescription>
        </Empty>
      )}
    </section>
  );
}
