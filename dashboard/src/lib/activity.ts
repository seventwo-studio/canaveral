import { instant } from "./clock";
import { record } from "./types";

/** The controller event log as the Activity page reads it: `GET /v1/admin/events` and its kind
 * catalogue, through the gateway.
 *
 * Live updates are cursor reads, not a relayed stream. The page asks for events after its cursor every
 * few seconds; the cursor is the one the controller returned, so nothing is lost or repeated between
 * reads, each read is one short authenticated request that ends with the session, and a hidden tab
 * simply stops asking. The controller's own stream is a one-second poll of this same list route and
 * holds one of 32 controller-wide follower slots for up to an hour, which a dashboard tab should not
 * take from CLI and application followers.
 *
 * The list route reads forwards only (`after`, oldest first) or the newest N (`tail`). Scrolling back
 * therefore works in two steps, both within that contract: grow the tail while it can hold what is
 * on screen, then walk fixed windows of sequence numbers backwards. */
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const KIND = /^[a-z]{1,24}\.[a-z_]{1,40}$/;
/** Events asked for at once when the page opens and for each step back. */
export const PAGE = 100;
/** The controller's bound on `tail` and `limit`. */
export const READ_LIMIT = 500;
/** Kinds one read may select. */
export const KIND_LIMIT = 32;
/** Events the page keeps. Live updates drop the oldest beyond it; scrolling back stops at it. */
export const HELD_LIMIT = 2000;
/** Windows one step back may walk before it reports what it searched. */
const WINDOWS_PER_STEP = 8;

export interface EventKindInfo {
  kind: string;
  summary: string;
  routine: boolean;
  attention: boolean;
}
export function eventKinds(value: unknown): EventKindInfo[] {
  const entries = record(value).kinds;
  if (!Array.isArray(entries) || !entries.length)
    throw new Error("Invalid event kind catalogue.");
  const seen = new Set<string>();
  return entries.map((entry) => {
    const { kind, summary, routine, attention } = record(entry);
    if (
      typeof kind !== "string" ||
      !KIND.test(kind) ||
      seen.has(kind) ||
      typeof summary !== "string" ||
      typeof routine !== "boolean" ||
      typeof attention !== "boolean"
    )
      throw new Error("Invalid event kind.");
    seen.add(kind);
    return { kind, summary, routine, attention };
  });
}
export const family = (kind: string): string => kind.split(".", 1)[0]!;
export const families = (catalogue: EventKindInfo[]): string[] => [
  ...new Set(catalogue.map((entry) => family(entry.kind))),
];

export const subjects = [
  ["applicationId", "Application", "application"],
  ["leaseId", "Lease", "lease"],
  ["requestId", "Request", "request"],
  ["hostId", "Host", "host"],
  ["machineId", "Machine", "machine"],
] as const;
export type SubjectFilter = (typeof subjects)[number][2];
export interface ActivityEvent {
  sequence: number;
  at: string;
  kind: string;
  applicationId?: string;
  leaseId?: string;
  requestId?: string;
  hostId?: string;
  machineId?: string;
  data: Record<string, unknown>;
}
export interface EventPage {
  events: ActivityEvent[];
  cursor: number;
  more: boolean;
  truncated: boolean;
  oldestSequence: number | null;
  latestSequence: number;
}
const sequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function eventPage(value: unknown): EventPage {
  const root = record(value);
  if (
    !Array.isArray(root.events) ||
    !sequence(root.cursor) ||
    typeof root.more !== "boolean" ||
    typeof root.truncated !== "boolean" ||
    !(root.oldestSequence === null || sequence(root.oldestSequence)) ||
    !sequence(root.latestSequence)
  )
    throw new Error("Invalid event page.");
  let last = 0;
  const events = root.events.map((entry): ActivityEvent => {
    const e = record(entry);
    if (
      !sequence(e.sequence) ||
      e.sequence <= last ||
      !instant(e.at) ||
      typeof e.kind !== "string" ||
      !KIND.test(e.kind)
    )
      throw new Error("Invalid event.");
    last = e.sequence;
    const event: ActivityEvent = {
      sequence: e.sequence,
      at: e.at,
      kind: e.kind,
      data: e.data === undefined ? {} : record(e.data),
    };
    for (const [key] of subjects) {
      if (e[key] === undefined) continue;
      if (typeof e[key] !== "string" || !UUID.test(e[key]))
        throw new Error("Invalid event subject.");
      event[key] = e[key];
    }
    return event;
  });
  return {
    events,
    cursor: root.cursor,
    more: root.more,
    truncated: root.truncated,
    oldestSequence: root.oldestSequence as number | null,
    latestSequence: root.latestSequence,
  };
}

export interface ActivityFilter {
  /** A kind family such as `lease`, or "" for all. */
  family: string;
  /** One exact kind, or "" for every kind of the family. */
  kind: string;
  /** Only the kinds the controller's catalogue marks as needing attention. */
  attention: boolean;
  application: string;
  lease: string;
  request: string;
  host: string;
  machine: string;
}
export const noFilter: ActivityFilter = {
  family: "",
  kind: "",
  attention: false,
  application: "",
  lease: "",
  request: "",
  host: "",
  machine: "",
};
export const filtered = (filter: ActivityFilter): boolean =>
  JSON.stringify(filter) !== JSON.stringify(noFilter);
export const validSubject = (value: string): boolean =>
  value === "" || UUID.test(value);

/** The `kind` parameters a filter needs.
 * `[]` means no restriction. `null` means the filter cannot be sent: it selects no kind at all, or it
 * selects more kinds than one read may carry. */
export function selectedKinds(
  filter: ActivityFilter,
  catalogue: EventKindInfo[],
): string[] | null {
  if (!filter.attention) {
    if (filter.kind) return [filter.kind];
    return filter.family ? [`${filter.family}.*`] : [];
  }
  const marked = catalogue
    .filter(
      (entry) =>
        entry.attention &&
        (!filter.family || family(entry.kind) === filter.family) &&
        (!filter.kind || entry.kind === filter.kind),
    )
    .map((entry) => entry.kind);
  return marked.length && marked.length <= KIND_LIMIT ? marked : null;
}
/** The query for one read, or null when the filter cannot be sent. Values are validated here and again
 * by the gateway, which accepts only these parameters in these shapes. */
export function eventQuery(
  filter: ActivityFilter,
  catalogue: EventKindInfo[],
  read: { tail: number } | { after: number; limit: number },
): string | null {
  const kinds = selectedKinds(filter, catalogue);
  if (kinds === null) return null;
  const query = new URLSearchParams();
  if ("tail" in read) query.set("tail", String(read.tail));
  else {
    query.set("after", String(read.after));
    query.set("limit", String(read.limit));
  }
  for (const kind of kinds) query.append("kind", kind);
  for (const [, , key] of subjects) {
    if (!filter[key]) continue;
    if (!UUID.test(filter[key])) return null;
    query.set(key, filter[key]);
  }
  return query.toString();
}

/** What the page holds for one filter. `events` are newest first. Every matching event with a sequence
 * from `floor` up to `cursor` is in `events`, unless live updates trimmed the oldest. */
export interface Feed {
  events: ActivityEvent[];
  /** The controller's cursor for the next live read. */
  cursor: number;
  /** Lower bound of what has been searched; nothing matching at or above it is missing. */
  floor: number;
  /** No older matching event is retained. */
  exhausted: boolean;
  oldestSequence: number | null;
  latestSequence: number;
}
export type ReadEvents = (
  read: { tail: number } | { after: number; limit: number },
) => Promise<EventPage>;

function merge(held: ActivityEvent[], incoming: ActivityEvent[]) {
  const bySequence = new Map(held.map((event) => [event.sequence, event]));
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => b.sequence - a.sequence);
}
/** The newest matching events. Fewer than asked for means there is nothing older. */
export async function openFeed(read: ReadEvents): Promise<Feed> {
  const page = await read({ tail: PAGE });
  const exhausted = page.events.length < PAGE;
  return {
    events: merge([], page.events),
    cursor: page.cursor,
    floor: exhausted ? (page.oldestSequence ?? 0) : page.events[0]!.sequence,
    exhausted,
    oldestSequence: page.oldestSequence,
    latestSequence: page.latestSequence,
  };
}
/** Events after the cursor. `truncated` says retention removed events this page never read. */
export async function followFeed(
  feed: Feed,
  read: ReadEvents,
): Promise<{ feed: Feed; added: number; truncated: boolean }> {
  const fresh: ActivityEvent[] = [];
  let { cursor, oldestSequence, latestSequence } = feed,
    truncated = false;
  for (let round = 0; round < 5; round++) {
    const page = await read({ after: cursor, limit: READ_LIMIT });
    fresh.push(...page.events);
    truncated ||= page.truncated;
    cursor = Math.max(cursor, page.cursor);
    oldestSequence = page.oldestSequence;
    latestSequence = page.latestSequence;
    if (!page.more) break;
  }
  let events = merge(feed.events, fresh),
    { floor, exhausted } = feed;
  const added = events.length - feed.events.length;
  if (events.length > HELD_LIMIT) {
    events = events.slice(0, HELD_LIMIT);
    floor = events.at(-1)!.sequence;
    exhausted = false;
  }
  return {
    feed: { events, cursor, floor, exhausted, oldestSequence, latestSequence },
    added,
    truncated,
  };
}
/** One step back through history. While the newest `tail` can still hold everything on screen plus a
 * page, it is read again larger, which finds sparse matches in one request. Beyond that the log is
 * walked backwards in windows of sequence numbers: a window of N sequences holds at most N events, so
 * one read of that size returns every match in it. The step ends once it found a page of events, ran
 * out of history, or walked its allowance of windows; `floor` records how far it searched. */
export async function olderFeed(
  feed: Feed,
  read: ReadEvents,
): Promise<{ feed: Feed; added: number }> {
  if (feed.exhausted || feed.events.length >= HELD_LIMIT)
    return { feed, added: 0 };
  let { events, floor, oldestSequence, latestSequence } = feed,
    exhausted: boolean = feed.exhausted;
  const before = events.length;
  if (before + PAGE <= READ_LIMIT) {
    const want = before + PAGE,
      page = await read({ tail: want });
    events = merge(events, page.events);
    oldestSequence = page.oldestSequence;
    latestSequence = page.latestSequence;
    exhausted = page.events.length < want;
    if (page.events.length) floor = Math.min(floor, page.events[0]!.sequence);
    if (exhausted) floor = Math.min(floor, oldestSequence ?? 0);
  } else {
    for (
      let round = 0;
      round < WINDOWS_PER_STEP && events.length - before < PAGE && !exhausted;
      round++
    ) {
      const after = Math.max(0, floor - READ_LIMIT - 1);
      const page = await read({ after, limit: READ_LIMIT });
      events = merge(
        events,
        page.events.filter((event) => event.sequence < floor),
      );
      oldestSequence = page.oldestSequence;
      latestSequence = page.latestSequence;
      floor = after + 1;
      exhausted =
        after === 0 || oldestSequence === null || floor <= oldestSequence;
    }
  }
  return {
    feed: { ...feed, events, floor, exhausted, oldestSequence, latestSequence },
    added: events.length - before,
  };
}

/** Payload fields as short text. Payloads hold identifiers, states and bounded codes only. */
export function dataFields(event: ActivityEvent): [string, string][] {
  return Object.entries(event.data)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => [
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ]);
}
