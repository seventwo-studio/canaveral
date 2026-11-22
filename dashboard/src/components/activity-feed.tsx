import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw, X } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import {
  HELD_LIMIT,
  KIND_LIMIT,
  dataFields,
  eventKinds,
  eventPage,
  eventQuery,
  families,
  family,
  filtered,
  followFeed,
  noFilter,
  olderFeed,
  openFeed,
  selectedKinds,
  subjects,
  validSubject,
  type ActivityEvent,
  type ActivityFilter,
  type EventKindInfo,
  type Feed,
  type ReadEvents,
  type SubjectFilter,
} from "@/lib/activity";
import { duration, localTime, useTick } from "@/lib/clock";
import type { User } from "@/lib/inventory";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Field, FieldError, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

/** Seconds between live reads while the tab is visible. */
const FOLLOW_SECONDS = 3;
const denied = (e: unknown) =>
  e !== null &&
  typeof e === "object" &&
  "status" in e &&
  (e.status === 401 || e.status === 403);
const select =
  "h-10 w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm md:h-9";
/** The subjects with a text field. Request and machine filters come from a link or an event. */
const typed = ["application", "host", "lease"] as const;
const labels: Record<SubjectFilter, string> = {
  application: "Application",
  host: "Host",
  lease: "Lease",
  request: "Request",
  machine: "Machine",
};

export function ActivityFeed({
  user,
  onDenied,
  initial,
}: {
  user: User;
  onDenied: () => void;
  /** A subject filter from the address, such as a lease opened from the Queue page. */
  initial?: Partial<Pick<ActivityFilter, SubjectFilter>>;
}) {
  // A new component instance fences every response when account identity or the linked subject changes.
  return (
    <ActivitySession
      key={`${user.id}:${user.role}:${user.status}:${JSON.stringify(initial ?? {})}`}
      user={user}
      onDenied={onDenied}
      initial={initial}
    />
  );
}
function ActivitySession({
  user,
  onDenied,
  initial,
}: Parameters<typeof ActivityFeed>[0]) {
  const [catalogue, setCatalogue] = useState<EventKindInfo[] | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>({
    ...noFilter,
    ...initial,
  });
  const [drafts, setDrafts] = useState<Record<(typeof typed)[number], string>>({
    application: initial?.application ?? "",
    host: initial?.host ?? "",
    lease: initial?.lease ?? "",
  });
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [missed, setMissed] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  /** On a narrow screen the identifier fields stay folded until asked for, so the first events are near the top. */
  const [subjectFields, setSubjectFields] = useState(false);
  const mounted = useRef(false),
    refused = useRef(false),
    // The read in flight, if any. A token rather than a flag: a read of an abandoned filter must not
    // release the lock a newer read holds.
    reading = useRef<object | null>(null),
    // Replies to a filter that is no longer selected are dropped.
    epoch = useRef(0),
    held = useRef<Feed | null>(null);
  const deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  held.current = feed;

  const fail = useCallback((e: unknown) => {
    if (denied(e)) {
      refused.current = true;
      setFeed(null);
      setCatalogue(null);
      setError("Administrator access is required.");
      deniedCallback.current();
    } else setError(errorMessage(e));
  }, []);
  const reader = useCallback(
    (kinds: EventKindInfo[], selected: ActivityFilter): ReadEvents | null =>
      eventQuery(selected, kinds, { tail: 0 }) === null
        ? null
        : (read) =>
            api(
              `admin/events?${eventQuery(selected, kinds, read)!}`,
              undefined,
              eventPage,
            ),
    [],
  );
  /** One read at a time. A reply is applied only while its filter is still the selected one. */
  const run = useCallback(
    async (work: (read: ReadEvents, held: Feed | null) => Promise<Feed>) => {
      if (!mounted.current || refused.current || reading.current || !catalogue)
        return;
      const read = reader(catalogue, filter);
      if (!read) return;
      const started = epoch.current,
        token = {};
      reading.current = token;
      try {
        const next = await work(read, held.current);
        if (!mounted.current || epoch.current !== started) return;
        setFeed(next);
        setCheckedAt(Date.now());
        setError("");
      } catch (e) {
        if (mounted.current && epoch.current === started) fail(e);
      } finally {
        if (reading.current === token) reading.current = null;
      }
    },
    [catalogue, filter, reader, fail],
  );
  const follow = useCallback(
    () =>
      run(async (read, current) => {
        if (!current) return openFeed(read);
        const result = await followFeed(current, read);
        if (result.truncated) setMissed(true);
        return result.feed;
      }),
    [run],
  );

  /** The kind catalogue names the families, the sentences and the attention marks. Nothing is read
   * without it, so a failed read of it is retried by the page's refresh action. */
  const loadKinds = useCallback(() => {
    if (refused.current || user.role !== "admin") return;
    void api("admin/events/kinds", undefined, eventKinds)
      .then((kinds) => {
        if (!mounted.current) return;
        setError("");
        setCatalogue(kinds);
      })
      .catch((e) => {
        if (mounted.current) fail(e);
      });
  }, [user.role, fail]);
  useEffect(() => {
    mounted.current = true;
    loadKinds();
    return () => {
      mounted.current = false;
    };
  }, []);
  // A changed filter starts a new feed; the previous one's late replies no longer apply.
  useEffect(() => {
    if (refused.current) return;
    epoch.current++;
    reading.current = null;
    setFeed(null);
    held.current = null;
    setMissed(false);
    setError("");
    if (catalogue) void run((read) => openFeed(read));
  }, [catalogue, filter]);
  useEffect(() => {
    if (paused || !catalogue) return;
    const visibleFollow = () => {
      if (!document.hidden) void follow();
    };
    const timer = setInterval(visibleFollow, FOLLOW_SECONDS * 1000);
    document.addEventListener("visibilitychange", visibleFollow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibleFollow);
    };
  }, [paused, catalogue, follow]);

  if (user.role !== "admin")
    return <p role="alert">Administrator access is required.</p>;

  const marked = catalogue
    ? catalogue.filter(
        (entry) =>
          entry.attention &&
          (!filter.family || family(entry.kind) === filter.family) &&
          (!filter.kind || entry.kind === filter.kind),
      ).length
    : 0;
  const sendable = !catalogue || selectedKinds(filter, catalogue) !== null;
  // A field that holds a value is never folded away.
  const subjectsOpen = subjectFields || typed.some((key) => drafts[key] !== "");
  const summaries = new Map(catalogue?.map((entry) => [entry.kind, entry]));
  const setSubject = useCallback((key: SubjectFilter, value: string) => {
    if ((typed as readonly string[]).includes(key))
      setDrafts((current) => ({ ...current, [key]: value }));
    setFilter((current) =>
      current[key] === value ? current : { ...current, [key]: value },
    );
  }, []);
  const clear = () => {
    // A subject that came from the address is cleared there, which starts a fresh page.
    if (initial && Object.keys(initial).length) location.hash = "activity";
    setDrafts({ application: "", host: "", lease: "" });
    setFilter(noFilter);
  };
  const older = async () => {
    setSearching(true);
    try {
      await run(async (read, current) =>
        current ? (await olderFeed(current, read)).feed : openFeed(read),
      );
    } finally {
      if (mounted.current) setSearching(false);
    }
  };
  const newest = feed?.events[0],
    oldest = feed?.events.at(-1);
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            The controller's event log, newest first: what changed on leases,
            requests, hosts, machines, operations and updates, written with each
            change. Events record state, never credentials, command arguments or
            results.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? (
              <Play aria-hidden="true" />
            ) : (
              <Pause aria-hidden="true" />
            )}
            {paused ? "Resume live updates" : "Pause live updates"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => (catalogue ? void follow() : loadKinds())}
          >
            <RefreshCw aria-hidden="true" />
            Refresh activity
          </Button>
        </div>
      </div>

      <form
        className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-y py-3 xl:grid-cols-6"
        aria-label="Filter events"
        onSubmit={(event) => event.preventDefault()}
      >
        <Field>
          <FieldLabel htmlFor="activity-family">Family</FieldLabel>
          <select
            id="activity-family"
            className={select}
            value={filter.family}
            disabled={!catalogue}
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                family: event.target.value,
                kind: "",
              }))
            }
          >
            <option value="">All families</option>
            {families(catalogue ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="activity-kind">Kind</FieldLabel>
          <select
            id="activity-kind"
            className={`${select} font-mono`}
            value={filter.kind}
            disabled={!catalogue}
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                kind: event.target.value,
                family: event.target.value
                  ? family(event.target.value)
                  : current.family,
              }))
            }
          >
            <option value="">
              {filter.family ? `All ${filter.family} kinds` : "All kinds"}
            </option>
            {(catalogue ?? [])
              .filter(
                (entry) =>
                  !filter.family || family(entry.kind) === filter.family,
              )
              .map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.kind}
                </option>
              ))}
          </select>
        </Field>
        <Button
          type="button"
          variant="outline"
          className="col-span-2 md:hidden"
          aria-expanded={subjectsOpen}
          onClick={() => setSubjectFields((value) => !value)}
        >
          {subjectsOpen
            ? "Hide application, host and lease"
            : "Filter by application, host or lease"}
        </Button>
        {typed.map((key) => {
          const invalid = !validSubject(drafts[key]);
          return (
            <Field
              key={key}
              data-invalid={invalid || undefined}
              className={`col-span-2 md:col-span-1 ${subjectsOpen ? "" : "hidden md:flex"}`}
            >
              <FieldLabel htmlFor={`activity-${key}`}>{labels[key]}</FieldLabel>
              <Input
                id={`activity-${key}`}
                className="font-mono text-xs"
                placeholder="UUID"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? `activity-${key}-error` : undefined}
                value={drafts[key]}
                onChange={(event) => {
                  const value = event.target.value.trim().toLowerCase();
                  setDrafts((current) => ({ ...current, [key]: value }));
                  // Only a complete identifier, or none, changes what is read, and only when it
                  // differs: an unchanged filter keeps its feed.
                  if (validSubject(value))
                    setFilter((current) =>
                      current[key] === value
                        ? current
                        : { ...current, [key]: value },
                    );
                }}
              />
              {invalid && (
                <FieldError id={`activity-${key}-error`}>
                  Enter a complete UUID.
                </FieldError>
              )}
            </Field>
          );
        })}
        <div className="col-span-2 flex min-w-0 flex-col justify-end gap-2 md:col-span-1">
          <label className="flex min-h-10 items-center gap-2 text-sm md:min-h-9">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={filter.attention}
              disabled={!catalogue}
              onChange={(event) =>
                setFilter((current) => ({
                  ...current,
                  attention: event.target.checked,
                }))
              }
            />
            Needs attention only
          </label>
        </div>
        {filtered(filter) && (
          <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 xl:col-span-6">
            {(["request", "machine"] as const).map(
              (key) =>
                filter[key] && (
                  <Badge key={key} variant="outline" className="max-w-full">
                    <span>{labels[key]}</span>
                    <span className="truncate font-mono">{filter[key]}</span>
                    <button
                      type="button"
                      className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove the ${key} filter`}
                      onClick={() => setSubject(key, "")}
                    >
                      <X aria-hidden="true" className="size-3" />
                    </button>
                  </Badge>
                ),
            )}
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              Clear filters
            </Button>
          </div>
        )}
      </form>

      {filter.attention && catalogue && (
        <p className="text-sm text-muted-foreground">
          {marked > KIND_LIMIT
            ? `The controller marks ${marked} of these kinds as needing attention, more than the ${KIND_LIMIT} one read can select. Choose a family to narrow it.`
            : marked === 0
              ? "No kind in this selection is marked as needing attention, so nothing can match."
              : `Showing the ${marked} ${marked === 1 ? "kind" : "kinds"} the controller marks as needing attention.`}
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="text-foreground">
            {feed ? "The activity shown is stale. " : ""}
            {error}
          </AlertDescription>
        </Alert>
      )}
      {missed && (
        <p role="status" className="text-sm">
          Retention removed events before this page read them. The list below
          has a gap; older history is gone from the log.
        </p>
      )}
      {!catalogue && !error && <p role="status">Loading event kinds…</p>}
      {catalogue && sendable && !feed && !error && (
        <p role="status">Loading activity…</p>
      )}
      {feed && (
        <p className="text-xs text-muted-foreground" aria-live="off">
          {paused
            ? "Live updates paused"
            : `Live · reads every ${FOLLOW_SECONDS} seconds while visible`}
          {checkedAt !== null && <LastRead at={checkedAt} />}
          {" · "}
          <span className="font-mono tabular-nums">
            {feed.events.length}
          </span>{" "}
          {feed.events.length === 1 ? "event" : "events"}
          {newest && oldest && (
            <>
              {" "}
              from sequence{" "}
              <span className="font-mono tabular-nums">
                {oldest.sequence}
              </span>{" "}
              to{" "}
              <span className="font-mono tabular-nums">{newest.sequence}</span>
            </>
          )}
          {" · log holds "}
          <span className="font-mono tabular-nums">
            {feed.oldestSequence ?? "nothing"}
          </span>
          {feed.oldestSequence !== null && (
            <>
              {" to "}
              <span className="font-mono tabular-nums">
                {feed.latestSequence}
              </span>
            </>
          )}
        </p>
      )}
      {feed && !feed.events.length && (
        <Empty showIcon>
          <EmptyHeader>
            <EmptyTitle>
              {filtered(filter)
                ? "No retained event matches these filters"
                : "The event log is empty"}
            </EmptyTitle>
            <EmptyDescription>
              {filtered(filter)
                ? "Events appear here as they are written. The log keeps a bounded history, 30 days and 100,000 events unless configured otherwise, so older matches may have been removed."
                : "An event is written with every change to a lease, request, host, machine, operation or update. A controller that has just started shows its start here first."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {feed && feed.events.length > 0 && (
        <ol
          aria-label="Events, newest first"
          className="min-w-0 divide-y border-y bg-card"
        >
          {feed.events.map((event) => (
            <EventRow
              key={event.sequence}
              event={event}
              info={summaries.get(event.kind)}
              onSubject={setSubject}
            />
          ))}
        </ol>
      )}
      {feed && (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {feed.exhausted ? (
            <p className="text-sm text-muted-foreground">
              {feed.events.length
                ? "No older retained event matches."
                : "Nothing older is retained."}
            </p>
          ) : feed.events.length >= HELD_LIMIT ? (
            <p className="text-sm text-muted-foreground">
              This page holds {HELD_LIMIT} events. Narrow the filters to look
              further back.
            </p>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={searching || !!error}
                onClick={() => void older()}
              >
                {searching ? "Searching…" : "Load older events"}
              </Button>
              <p className="text-sm text-muted-foreground">
                Searched back to sequence{" "}
                <span className="font-mono tabular-nums">{feed.floor}</span>.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Ticks on its own, so the list of events is not rendered again every second. */
function LastRead({ at }: { at: number }) {
  useTick();
  return <> · last read {duration((Date.now() - at) / 1000)} ago</>;
}
const EventRow = memo(function EventRow({
  event,
  info,
  onSubject,
}: {
  event: ActivityEvent;
  info: EventKindInfo | undefined;
  onSubject: (key: SubjectFilter, value: string) => void;
}) {
  const fields = dataFields(event);
  return (
    <li className="grid min-w-0 gap-2 px-1 py-3 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-4">
      <div className="min-w-0 space-y-1">
        <time
          dateTime={event.at}
          title={event.at}
          className="block font-mono text-xs tabular-nums"
        >
          {localTime(event.at)}
        </time>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          sequence {event.sequence}
        </p>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
            {event.kind}
          </span>
          {info?.attention && (
            <Badge variant="outline" className="status status-error">
              <span className="status-dot" aria-hidden="true" />
              Needs attention
            </Badge>
          )}
        </div>
        {info && <p className="text-sm">{info.summary}</p>}
        <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2">
          {subjects.map(
            ([key, label, filter]) =>
              event[key] && (
                <div key={key} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="min-w-0">
                    <button
                      type="button"
                      className="max-w-full rounded-sm text-left font-mono text-xs underline-offset-4 outline-none [overflow-wrap:anywhere] hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Show only ${label.toLowerCase()} ${event[key]}`}
                      onClick={() => onSubject(filter, event[key]!)}
                    >
                      {event[key]}
                    </button>
                  </dd>
                </div>
              ),
          )}
        </dl>
        {fields.length > 0 && (
          <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs">
            {fields.map(([key, value]) => (
              <div key={key} className="flex min-w-0 gap-1">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="font-mono [overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
});
