import { WorkspaceHeaderActions } from "./workspace-header-actions";
import { NativeSelect } from "./ui/native-select";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Search, RefreshCw } from "lucide-react";
import { api, errorMessage, memory, number, provider } from "@/lib/api";
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
import { Badge } from "./ui/badge";
import { Alert, AlertDescription } from "./ui/alert";
import { InputGroup, InputGroupInput, InputGroupAddon } from "./ui/input-group";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Field, FieldLabel, FieldDescription, FieldGroup } from "./ui/field";
import {
  Empty,
  FilteredEmpty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "./ui/empty";

const sourceKey = (
  source: { id: string; revision: string; arch: string } | undefined,
) => (source ? JSON.stringify([source.id, source.revision, source.arch]) : "");

function CatalogueNotice({
  error,
  loaded,
  name,
}: {
  error: string;
  loaded: boolean;
  name: string;
}) {
  return error ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>
        {loaded
          ? `${name} could not be refreshed. Showing the last snapshot.`
          : `${name} could not be loaded.`}
        <details className="mt-1 text-xs">
          <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Connection details
          </summary>
          <p className="mt-2 break-words">{error}</p>
        </details>
      </AlertDescription>
    </Alert>
  ) : null;
}

function CatalogueToolbar({
  query,
  onQuery,
  label,
  placeholder,
  loaded,
  count,
  total,
  refreshing,
  onRefresh,
}: {
  query: string;
  onQuery: (value: string) => void;
  label: string;
  placeholder: string;
  loaded: boolean;
  count: number;
  total: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b pb-2 sm:flex sm:flex-wrap">
      <InputGroup className="h-10 w-full sm:max-w-64 md:h-8">
        <InputGroupInput
          aria-label={label}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
      </InputGroup>
      {loaded && (
        <span className="col-start-1 row-start-2 text-xs text-muted-foreground tabular-nums">
          {count} of {total}
        </span>
      )}
      {query && count > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="col-start-2 row-start-2 justify-self-end sm:ml-auto"
          onClick={() => onQuery("")}
        >
          Clear search
        </Button>
      )}
      <Button
        className={`col-start-2 row-start-1 ${query && count > 0 ? "" : "sm:ml-auto"}`}
        variant="outline"
        size="default"
        disabled={refreshing}
        aria-label={`Refresh ${label.replace(/^Search /, "")}`}
        onClick={onRefresh}
      >
        <RefreshCw aria-hidden="true" />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  );
}

// Wide catalogues align identity, specifications and actions across each row.
const catalogueRow =
  "min-w-0 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(12rem,0.8fr)] xl:items-start xl:gap-6 xl:rounded-none xl:border-0 xl:px-3 xl:shadow-none";

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
    [refreshing, setRefreshing] = useState(true),
    [reload, setReload] = useState(0),
    [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true,
      epoch = 0,
      inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const request = ++epoch;
      setRefreshing(true);
      try {
        const value = await api("image-library", undefined, libraryImages);
        if (alive && request === epoch) {
          setImages(value);
          setLoaded(true);
          setError("");
        }
      } catch (e) {
        if (alive && request === epoch) setError(errorMessage(e));
      } finally {
        inFlight = false;
        if (alive && request === epoch) setRefreshing(false);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reload]);
  const visible = images.filter((i) =>
    [i.name, i.os, i.arch, i.registry?.version]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="min-w-0 space-y-4">
      <CatalogueNotice error={error} loaded={loaded} name="Image library" />
      <CatalogueToolbar
        query={query}
        onQuery={setQuery}
        label="Search image library"
        placeholder="Search images…"
        loaded={loaded}
        count={visible.length}
        total={images.length}
        refreshing={refreshing}
        onRefresh={() => setReload((v) => v + 1)}
      />
      {!loaded ? (
        <Empty className="min-h-44 flex-none">
          <EmptyHeader>
            <EmptyTitle role={error ? undefined : "status"}>
              {error ? "Image library unavailable" : "Loading image library…"}
            </EmptyTitle>
            {error && (
              <EmptyDescription>
                Retry to load your downloaded images.
              </EmptyDescription>
            )}
          </EmptyHeader>
          {error && (
            <EmptyContent>
              <Button
                variant="outline"
                disabled={refreshing}
                onClick={() => setReload((v) => v + 1)}
              >
                Retry image library
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : !visible.length && images.length > 0 ? (
        <FilteredEmpty
          title="No matching images"
          action="Clear search"
          onClear={() => setQuery("")}
        />
      ) : !visible.length ? (
        <Empty showIcon className="min-h-44 flex-none">
          <EmptyHeader>
            <EmptyTitle role="heading" aria-level={2}>
              No downloaded images
            </EmptyTitle>
            <EmptyDescription>
              Download an original from the registry or import a publisher file.
            </EmptyDescription>
          </EmptyHeader>
          {query && (
            <EmptyContent>
              <Button variant="outline" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2 xl:grid-cols-1 xl:gap-0 xl:divide-y xl:border-y">
          {visible.map((i) => {
            const source = sources.find((s) => s.id === i.id);
            const available = source?.hosts.some(
              (h) => h.id === i.hostId && h.online && h.accepting,
            );
            return (
              <Card key={i.id} className={catalogueRow}>
                <CardHeader className="min-w-0 xl:px-0">
                  <CardTitle className="break-words text-base font-semibold tracking-tight">
                    {i.name}
                  </CardTitle>
                  <CardDescription>
                    {provider(i.os)} · {i.arch} · {i.format.toUpperCase()}
                  </CardDescription>
                  <Badge
                    variant="outline"
                    className={
                      available ? "status-ready mt-1" : "status-pending mt-1"
                    }
                  >
                    {available ? "Available on host" : "Awaiting host"}
                  </Badge>
                </CardHeader>
                <CardContent className="min-w-0 space-y-3 text-xs xl:px-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">
                      {i.mediaType === "installer" ? "Installer" : "Boot disk"}
                    </span>
                    <span className="tabular-nums">
                      {i.bytes >= 1073741824
                        ? `${number(i.bytes / 1073741824)} GiB`
                        : i.bytes >= 1048576
                          ? `${number(i.bytes / 1048576)} MiB`
                          : `${i.bytes.toLocaleString()} bytes`}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    {i.registry
                      ? i.registry.publisherSha256
                        ? "Publisher SHA-256 matched"
                        : "Apple restore source · local SHA-256 recorded"
                      : "Manual import · publisher provenance unverified"}
                  </p>
                  <details className="min-w-0 border-t pt-3">
                    <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Source & checksum
                    </summary>
                    <dl className="mt-3 space-y-2">
                      <div>
                        <dt className="text-muted-foreground">SHA-256</dt>
                        <dd className="mt-1 break-all font-mono">{i.sha256}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Size</dt>
                        <dd>{i.bytes.toLocaleString()} bytes</dd>
                      </div>
                    </dl>
                    {i.registry && (
                      <a
                        className="mt-3 inline-block break-all underline underline-offset-4"
                        href={i.registry.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Original download · {i.registry.version}
                      </a>
                    )}
                  </details>
                </CardContent>
                {admin && (
                  <CardFooter className="mt-auto xl:mt-0 xl:justify-end xl:px-0">
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
    </div>
  );
}

export function MachineBlueprints({
  headerActions,
  sources,
  admin,
  onCreate,
  inventoryAvailable = true,
}: {
  headerActions?: HTMLElement | null;
  sources: GroupedImage[];
  admin: boolean;
  onCreate: (offer: GroupedImage) => void;
  inventoryAvailable?: boolean;
}) {
  const [items, setItems] = useState<Blueprint[]>([]),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [refreshing, setRefreshing] = useState(true),
    [editing, setEditing] = useState<Blueprint | "new" | null>(null),
    [query, setQuery] = useState("");
  const alive = useRef(true),
    epoch = useRef(0);
  const refresh = async () => {
    const request = ++epoch.current;
    setRefreshing(true);
    try {
      const value = await api("blueprints", undefined, blueprints);
      if (alive.current && request === epoch.current) {
        setItems(value);
        setLoaded(true);
        setError("");
      }
    } catch (e) {
      if (alive.current && request === epoch.current) setError(errorMessage(e));
    } finally {
      if (alive.current && request === epoch.current) setRefreshing(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      ++epoch.current;
    };
  }, []);
  const visible = items.filter((b) =>
    [b.name, b.revision, b.image.os, b.image.arch]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      {admin && (
        <WorkspaceHeaderActions container={headerActions}>
          <Button data-header-primary onClick={() => setEditing("new")}>
            New<span className="max-sm:sr-only"> blueprint</span>
          </Button>
        </WorkspaceHeaderActions>
      )}
      <CatalogueNotice error={error} loaded={loaded} name="Blueprints" />
      {!inventoryAvailable && (
        <Alert role="status">
          <AlertDescription>
            Host availability unavailable. Refresh inventory from the workspace
            header before creating a machine.
          </AlertDescription>
        </Alert>
      )}
      <CatalogueToolbar
        query={query}
        onQuery={setQuery}
        label="Search machine blueprints"
        placeholder="Search blueprints…"
        loaded={loaded}
        count={visible.length}
        total={items.length}
        refreshing={refreshing}
        onRefresh={() => {
          void refresh();
        }}
      />
      {!loaded ? (
        <Empty className="min-h-44 flex-none">
          <EmptyHeader>
            <EmptyTitle role={error ? undefined : "status"}>
              {error ? "Blueprints unavailable" : "Loading blueprints…"}
            </EmptyTitle>
            {error && (
              <EmptyDescription>
                Retry to load saved machine definitions.
              </EmptyDescription>
            )}
          </EmptyHeader>
          {error && (
            <EmptyContent>
              <Button
                variant="outline"
                disabled={refreshing}
                onClick={() => {
                  void refresh();
                }}
              >
                Retry blueprints
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : !visible.length && items.length > 0 ? (
        <FilteredEmpty
          title="No matching blueprints"
          action="Clear search"
          onClear={() => setQuery("")}
        />
      ) : !visible.length ? (
        <Empty showIcon className="min-h-44 flex-none">
          <EmptyHeader>
            <EmptyTitle role="heading" aria-level={2}>
              No machine blueprints
            </EmptyTitle>
            <EmptyDescription>
              Save resource settings for a downloaded image or prepared
              snapshot.
            </EmptyDescription>
          </EmptyHeader>
          {query && (
            <EmptyContent>
              <Button variant="outline" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2 xl:grid-cols-1 xl:gap-0 xl:divide-y xl:border-y">
          {visible.map((b) => {
            const offered = blueprintOffer(b, sources),
              available =
                inventoryAvailable &&
                offered.hosts.some((h) => h.online && h.accepting);
            return (
              <Card
                key={JSON.stringify([b.id, b.revision])}
                className={catalogueRow}
              >
                <CardHeader className="min-w-0 xl:px-0">
                  <CardTitle className="break-words text-base font-semibold tracking-tight">
                    {b.name}
                  </CardTitle>
                  <CardDescription>
                    Revision {b.revision} · {provider(b.image.os)} ·{" "}
                    {b.image.arch}
                  </CardDescription>
                  <Badge
                    variant="outline"
                    className={`mt-1 max-w-full whitespace-normal ${inventoryAvailable ? (available ? "status-ready" : "status-pending") : ""}`}
                  >
                    {!inventoryAvailable
                      ? "Host availability unavailable"
                      : available
                        ? "Available"
                        : "Awaiting host"}
                  </Badge>
                </CardHeader>
                <CardContent className="min-w-0 space-y-3 text-xs xl:px-0">
                  <dl className="grid grid-cols-3 gap-3">
                    <div>
                      <dt className="text-muted-foreground">CPU</dt>
                      <dd className="mt-1 tabular-nums">
                        {b.defaults.cpu} vCPU
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Memory</dt>
                      <dd className="mt-1 tabular-nums">
                        {memory(b.defaults.memoryMiB)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Disk</dt>
                      <dd className="mt-1 tabular-nums">
                        {b.defaults.diskGiB} GiB
                      </dd>
                    </div>
                  </dl>
                  <p className="break-words border-t pt-3 text-muted-foreground">
                    {b.image.imageKind === "derived"
                      ? "Prepared snapshot"
                      : "Source image"}
                    : {b.image.name || b.source.id} · {b.source.revision}
                  </p>
                  {inventoryAvailable && !available && (
                    <p className="text-muted-foreground">
                      No accepting host offers this source revision.
                    </p>
                  )}
                </CardContent>
                <CardFooter className="mt-auto flex flex-wrap gap-2 xl:mt-0 xl:justify-end xl:px-0">
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
        <form onSubmit={submit} className="@container/blueprint space-y-4">
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
                aria-describedby="blueprint-revision-hint"
                name="revision"
                defaultValue={previous ? "" : "1"}
                required
                disabled={busy}
              />
              <FieldDescription id="blueprint-revision-hint">
                Saved revisions are immutable.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="blueprint-source">
                Source image or prepared snapshot
              </FieldLabel>
              <NativeSelect
                id="blueprint-source"
                value={selected}
                disabled={busy}
                onChange={(e) => setSelected(e.target.value)}
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
              </NativeSelect>
            </Field>
            {source ? (
              <div
                key={JSON.stringify([source.id, source.revision, source.arch])}
                className="grid gap-3 @sm/blueprint:grid-cols-3"
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
          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
