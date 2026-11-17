import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage, memory } from "@/lib/api";
import {
  blueprint,
  blueprints,
  blueprintOffer,
  libraryImages,
} from "@/lib/blueprints";
import type { Blueprint, LibraryImage } from "@/lib/blueprints";
import type { GroupedImage } from "@/lib/inventory";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Field, FieldLabel, FieldDescription, FieldGroup } from "./ui/field";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./ui/empty";

const sourceKey = (
  source: { id: string; revision: string; arch: string } | undefined,
) => (source ? JSON.stringify([source.id, source.revision, source.arch]) : "");

export function ImageLibrary({
  sources,
  onBlueprint,
  admin,
}: {
  sources: GroupedImage[];
  onBlueprint: (source: GroupedImage) => void;
  admin: boolean;
}) {
  const [images, setImages] = useState<LibraryImage[]>([]),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api("image-library", undefined, libraryImages)
        .then((value) => {
          if (alive) {
            setImages(value);
            setLoaded(true);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const visible = images.filter((i) =>
    [i.name, i.os, i.arch, i.registry?.version]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh the library. {error}
        </p>
      )}
      <Input
        aria-label="Search image library"
        placeholder="Search images…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!loaded && !error ? (
        <p>Loading image library…</p>
      ) : !visible.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No downloaded images</EmptyTitle>
            <EmptyDescription>
              Download an original from the registry or import a publisher file.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {visible.map((i) => {
            const source = sources.find((s) => s.id === i.id);
            const available = source?.hosts.some(
              (h) => h.id === i.hostId && h.online && h.accepting,
            );
            return (
              <Card key={i.id} className="min-w-0">
                <CardHeader>
                  <CardTitle className="break-words">{i.name}</CardTitle>
                  <CardDescription>
                    {i.os} · {i.arch} ·{" "}
                    {i.mediaType === "installer" ? "Installer" : "Boot disk"} ·{" "}
                    {i.format.toUpperCase()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    {i.registry
                      ? i.registry.publisherSha256
                        ? "Publisher SHA-256 matched"
                        : "Apple restore source · local SHA-256 recorded"
                      : "Manual import · publisher provenance unverified"}
                  </p>
                  <p className="break-all">SHA-256: {i.sha256}</p>
                  <p>
                    {i.bytes.toLocaleString()} bytes ·{" "}
                    {available
                      ? "Available on host"
                      : "Awaiting an accepting host"}
                  </p>
                  {i.registry && (
                    <a
                      className="break-all underline"
                      href={i.registry.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Original download · {i.registry.version}
                    </a>
                  )}
                </CardContent>
                {admin && (
                  <CardFooter>
                    <Button
                      variant="outline"
                      disabled={!source || !!error}
                      onClick={() => {
                        if (source) onBlueprint(source);
                      }}
                    >
                      Create blueprint
                    </Button>
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

export function MachineBlueprints({
  sources,
  admin,
  onCreate,
}: {
  sources: GroupedImage[];
  admin: boolean;
  onCreate: (offer: GroupedImage) => void;
}) {
  const [items, setItems] = useState<Blueprint[]>([]),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [editing, setEditing] = useState<Blueprint | "new" | null>(null),
    [query, setQuery] = useState("");
  const alive = useRef(true);
  const refresh = async () => {
    try {
      const value = await api("blueprints", undefined, blueprints);
      if (alive.current) {
        setItems(value);
        setLoaded(true);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, []);
  const visible = items.filter((b) =>
    [b.name, b.revision, b.image.os, b.image.arch]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-medium">
            Machine blueprints
          </h1>
          <p className="text-sm text-muted-foreground">
            Reusable resources and a pinned OS image or prepared snapshot.
          </p>
        </div>
        {admin && (
          <Button onClick={() => setEditing("new")}>New blueprint</Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh blueprints. {error}
        </p>
      )}
      <Input
        aria-label="Search machine blueprints"
        placeholder="Search blueprints…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!loaded && !error ? (
        <p>Loading blueprints…</p>
      ) : !visible.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No machine blueprints</EmptyTitle>
            <EmptyDescription>
              Choose a downloaded image or a captured prepared machine, then
              save its resource settings.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {visible.map((b) => {
            const offered = blueprintOffer(b, sources),
              available = offered.hosts.some((h) => h.online && h.accepting);
            return (
              <Card
                key={JSON.stringify([b.id, b.revision])}
                className="min-w-0"
              >
                <CardHeader>
                  <CardTitle className="break-words">{b.name}</CardTitle>
                  <CardDescription>
                    Revision {b.revision} · {b.image.os} · {b.image.arch}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p>
                    {b.defaults.cpu} vCPU · {memory(b.defaults.memoryMiB)} ·{" "}
                    {b.defaults.diskGiB} GiB disk
                  </p>
                  <p className="break-words text-muted-foreground">
                    {b.image.imageKind === "derived"
                      ? "Prepared snapshot"
                      : "Source image"}
                    : {b.image.name || b.source.id} · {b.source.revision}
                  </p>
                  {!available && (
                    <p className="text-muted-foreground">
                      No accepting host offers this source revision.
                    </p>
                  )}
                </CardContent>
                <CardFooter className="flex flex-wrap gap-2">
                  <Button
                    disabled={!available || !!error}
                    onClick={() => onCreate(offered)}
                  >
                    Create machine
                  </Button>
                  {admin && (
                    <Button variant="outline" onClick={() => setEditing(b)}>
                      New revision
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
      {editing && admin && (
        <BlueprintEditor
          sources={sources.filter((s) => s.mode !== "device")}
          previous={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

export function BlueprintEditor({
  sources,
  previous,
  initialSource,
  onClose,
  onSaved,
}: {
  sources: GroupedImage[];
  previous: Blueprint | null;
  initialSource?: GroupedImage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState(
      sourceKey(initialSource ?? previous?.source ?? sources[0]),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const source = sources.find((s) => sourceKey(s) === selected),
    identity = useRef(previous?.id ?? crypto.randomUUID()),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!source || busy) return;
    const data = new FormData(e.currentTarget);
    const spec = {
      id: identity.current,
      name: String(data.get("name") || "").trim(),
      revision: String(data.get("revision") || "").trim(),
      source: { id: source.id, revision: source.revision, arch: source.arch },
      minimum: source.minimum,
      defaults: {
        cpu: Number(data.get("cpu")),
        memoryMiB: Number(data.get("memoryMiB")),
        diskGiB: Number(data.get("diskGiB")),
      },
    };
    setBusy(true);
    setError("");
    try {
      await api("blueprints", spec, (value) => {
        const b = blueprint(value);
        if (
          b.id !== spec.id ||
          b.revision !== spec.revision ||
          b.name !== spec.name ||
          JSON.stringify(b.source) !== JSON.stringify(spec.source) ||
          Object.entries(spec.defaults).some(
            ([key, value]) =>
              b.defaults[key as keyof typeof b.defaults] !== value,
          )
        )
          throw new Error(
            "Blueprint save was not confirmed. Retry the same revision to check its outcome.",
          );
        return b;
      });
      if (alive.current) onSaved();
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {previous ? "New blueprint revision" : "New machine blueprint"}
          </DialogTitle>
          <DialogDescription>
            Original images stay unchanged. Each machine receives its own
            writable disk.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="blueprint-name">Blueprint name</FieldLabel>
              <Input
                id="blueprint-name"
                name="name"
                defaultValue={previous?.name ?? ""}
                required
                disabled={busy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="blueprint-revision">Revision</FieldLabel>
              <Input
                id="blueprint-revision"
                name="revision"
                defaultValue={previous ? "" : "1"}
                required
                disabled={busy}
              />
              <FieldDescription>
                Saved revisions are immutable.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="blueprint-source">
                Source image or prepared snapshot
              </FieldLabel>
              <select
                id="blueprint-source"
                value={selected}
                disabled={busy}
                onChange={(e) => setSelected(e.target.value)}
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
              >
                {!source && (
                  <option value={selected} disabled>
                    Selected source is unavailable
                  </option>
                )}
                {sources.map((s) => (
                  <option
                    key={JSON.stringify([s.id, s.revision, s.arch])}
                    value={sourceKey(s)}
                  >
                    {s.name || s.id} · {s.revision} · {s.arch}
                    {s.imageKind === "derived" ? " · Prepared snapshot" : ""}
                  </option>
                ))}
              </select>
            </Field>
            {source ? (
              <div
                key={JSON.stringify([source.id, source.revision, source.arch])}
                className="grid grid-cols-3 gap-3"
              >
                {(["cpu", "memoryMiB", "diskGiB"] as const).map((k) => (
                  <Field key={k}>
                    <FieldLabel htmlFor={`blueprint-${k}`}>
                      {k === "cpu"
                        ? "vCPU"
                        : k === "memoryMiB"
                          ? "Memory (MiB)"
                          : "Disk (GiB)"}
                    </FieldLabel>
                    <Input
                      id={`blueprint-${k}`}
                      name={k}
                      type="number"
                      required
                      min={source.minimum[k]}
                      step={k === "memoryMiB" ? source.memoryStepMiB || 1 : 1}
                      defaultValue={
                        (previous?.defaults ??
                          source.defaults ??
                          source.minimum)[k]
                      }
                      disabled={busy}
                    />
                  </Field>
                ))}
              </div>
            ) : (
              <p>No registered VM sources. Download an image first.</p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !source}>
              {busy ? "Saving…" : "Save blueprint"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
