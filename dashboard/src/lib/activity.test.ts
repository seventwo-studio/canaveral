import { expect, test } from "vitest";
import {
  HELD_LIMIT,
  PAGE,
  READ_LIMIT,
  dataFields,
  eventKinds,
  eventPage,
  eventQuery,
  families,
  followFeed,
  noFilter,
  olderFeed,
  openFeed,
  selectedKinds,
} from "./activity";
import type { ActivityEvent, EventPage, ReadEvents } from "./activity";

const catalogue = [
  {
    kind: "lease.admitted",
    summary: "A lease was admitted.",
    routine: false,
    attention: false,
  },
  {
    kind: "lease.failed",
    summary: "A lease failed.",
    routine: false,
    attention: true,
  },
  {
    kind: "host.offline",
    summary: "A host stopped reporting.",
    routine: false,
    attention: true,
  },
  {
    kind: "operation.succeeded",
    summary: "An operation succeeded.",
    routine: true,
    attention: false,
  },
];
const lease = "b7682a27-b32e-472a-8a4d-f54a98a6d962";
const event = (sequence: number, kind = "lease.admitted"): ActivityEvent => ({
  sequence,
  at: new Date(Date.UTC(2026, 10, 21) + sequence * 1000).toISOString(),
  kind,
  data: {},
});

/** The list route's contract over an in-memory log: `tail` returns the newest matches, `after` reads
 * forwards with a limit, the cursor moves to the head once the last page is read. */
function log(events: ActivityEvent[]) {
  const reads: string[] = [];
  const state = { events, oldest: events[0]?.sequence ?? null };
  const read: ReadEvents = async (request) => {
    const latest = state.events.at(-1)?.sequence ?? 0;
    const base = { oldestSequence: state.oldest, latestSequence: latest };
    if ("tail" in request) {
      reads.push(`tail=${request.tail}`);
      return {
        events: state.events
          .slice(-request.tail || state.events.length)
          .slice(request.tail ? 0 : state.events.length),
        cursor: latest,
        more: false,
        truncated: false,
        ...base,
      };
    }
    reads.push(`after=${request.after}`);
    const matching = state.events.filter((e) => e.sequence > request.after);
    const page = matching.slice(0, request.limit),
      more = matching.length > request.limit;
    return {
      events: page,
      cursor: more ? page.at(-1)!.sequence : Math.max(request.after, latest),
      more,
      truncated: state.oldest !== null && request.after + 1 < state.oldest,
      ...base,
    } satisfies EventPage;
  };
  return { read, reads, state };
}
const sequences = (events: ActivityEvent[]) => events.map((e) => e.sequence);

test("the kind catalogue and event pages are decoded strictly", () => {
  expect(eventKinds({ kinds: catalogue })).toEqual(catalogue);
  expect(families(catalogue)).toEqual(["lease", "host", "operation"]);
  for (const broken of [
    {},
    { kinds: [] },
    { kinds: [{ ...catalogue[0], attention: "yes" }] },
    { kinds: [catalogue[0], catalogue[0]] },
    { kinds: [{ ...catalogue[0], kind: "Lease" }] },
  ])
    expect(() => eventKinds(broken)).toThrow();
  const page = {
    events: [
      {
        ...event(7),
        leaseId: lease,
        subject: lease,
        data: { reason: "runtime_error" },
      },
    ],
    cursor: 7,
    more: false,
    truncated: false,
    oldestSequence: 1,
    latestSequence: 7,
  };
  expect(eventPage(page).events[0]).toEqual({
    ...event(7),
    leaseId: lease,
    data: { reason: "runtime_error" },
  });
  for (const broken of [
    { ...page, cursor: -1 },
    { ...page, more: "no" },
    { ...page, latestSequence: undefined },
    { ...page, events: [{ ...event(7), at: "yesterday" }] },
    { ...page, events: [{ ...event(7), leaseId: "lease" }] },
    { ...page, events: [event(7), event(7)] },
    { ...page, events: [event(8), event(7)] },
    { ...page, events: [{ ...event(7), data: "text" }] },
  ])
    expect(() => eventPage(broken)).toThrow();
  expect(
    dataFields({
      ...event(1),
      data: {
        reason: "runtime_error",
        attempts: 3,
        nested: { a: 1 },
        none: null,
      },
    }),
  ).toEqual([
    ["reason", "runtime_error"],
    ["attempts", "3"],
    ["nested", '{"a":1}'],
  ]);
});

test("filters become kind and subject parameters, and the attention filter uses the catalogue's marks", () => {
  expect(selectedKinds(noFilter, catalogue)).toEqual([]);
  expect(selectedKinds({ ...noFilter, family: "lease" }, catalogue)).toEqual([
    "lease.*",
  ]);
  expect(
    selectedKinds(
      { ...noFilter, family: "lease", kind: "lease.failed" },
      catalogue,
    ),
  ).toEqual(["lease.failed"]);
  expect(selectedKinds({ ...noFilter, attention: true }, catalogue)).toEqual([
    "lease.failed",
    "host.offline",
  ]);
  expect(
    selectedKinds({ ...noFilter, attention: true, family: "host" }, catalogue),
  ).toEqual(["host.offline"]);
  // A selection the attention marks cannot satisfy is not sent as an unfiltered read.
  expect(
    selectedKinds(
      { ...noFilter, attention: true, family: "operation" },
      catalogue,
    ),
  ).toBeNull();
  expect(
    selectedKinds(
      { ...noFilter, attention: true, kind: "lease.admitted", family: "lease" },
      catalogue,
    ),
  ).toBeNull();
  const many = Array.from({ length: 33 }, (_, n) => ({
    kind: `lease.k${"abcdefghijklmnopqrstuvwxyzabcdefg"[n]}`,
    summary: "",
    routine: false,
    attention: true,
  }));
  expect(selectedKinds({ ...noFilter, attention: true }, many)).toBeNull();
  expect(
    selectedKinds({ ...noFilter, attention: true }, many.slice(0, 32)),
  ).toHaveLength(32);

  expect(eventQuery(noFilter, catalogue, { tail: 100 })).toBe("tail=100");
  expect(
    eventQuery(
      { ...noFilter, attention: true, lease, application: lease },
      catalogue,
      { after: 12, limit: 500 },
    ),
  ).toBe(
    `after=12&limit=500&kind=lease.failed&kind=host.offline&application=${lease}&lease=${lease}`,
  );
  expect(
    eventQuery({ ...noFilter, family: "lease" }, catalogue, { tail: 1 }),
  ).toBe("tail=1&kind=lease.*");
  expect(
    eventQuery({ ...noFilter, host: "not-a-uuid" }, catalogue, { tail: 1 }),
  ).toBeNull();
  expect(
    eventQuery(
      { ...noFilter, attention: true, family: "operation" },
      catalogue,
      { tail: 1 },
    ),
  ).toBeNull();
});

test("opening reads the newest page; fewer than a page means nothing older exists", async () => {
  const few = log(Array.from({ length: 40 }, (_, n) => event(n + 10)));
  const short = await openFeed(few.read);
  expect(sequences(short.events).slice(0, 3)).toEqual([49, 48, 47]);
  expect(short.exhausted).toBe(true);
  expect(short.cursor).toBe(49);
  expect((await olderFeed(short, few.read)).added).toBe(0);
  expect(few.reads).toEqual([`tail=${PAGE}`]);

  const full = log(Array.from({ length: 250 }, (_, n) => event(n + 1)));
  const feed = await openFeed(full.read);
  expect(feed.events).toHaveLength(PAGE);
  expect(feed.exhausted).toBe(false);
  expect(feed.floor).toBe(151);

  const empty = await openFeed(log([]).read);
  expect(empty.events).toEqual([]);
  expect(empty.exhausted).toBe(true);
});

test("following reads from the controller's cursor: nothing is repeated and nothing is skipped", async () => {
  const source = log(Array.from({ length: 120 }, (_, n) => event(n + 1)));
  let feed = await openFeed(source.read);
  let step = await followFeed(feed, source.read);
  expect(step.added).toBe(0);
  expect(step.feed.cursor).toBe(120);
  // More than one page arrives between reads: the follow drains it within the same step.
  source.state.events.push(
    ...Array.from({ length: 1200 }, (_, n) => event(121 + n)),
  );
  step = await followFeed(step.feed, source.read);
  expect(step.added).toBe(1200);
  expect(step.feed.cursor).toBe(1320);
  expect(sequences(step.feed.events).slice(0, 2)).toEqual([1320, 1319]);
  expect(new Set(sequences(step.feed.events)).size).toBe(
    step.feed.events.length,
  );
  expect(source.reads.slice(-3)).toEqual([
    "after=120",
    "after=620",
    "after=1120",
  ]);
  // A cursor behind retention is reported, not hidden.
  source.state.oldest = 2000;
  source.state.events = [event(2000), event(2001)];
  feed = step.feed;
  step = await followFeed(feed, source.read);
  expect(step.truncated).toBe(true);
  expect(sequences(step.feed.events).slice(0, 2)).toEqual([2001, 2000]);
});

test("live updates keep a bounded list and reopen history they dropped", async () => {
  const source = log(Array.from({ length: 30 }, (_, n) => event(n + 1)));
  const feed = await openFeed(source.read);
  expect(feed.exhausted).toBe(true);
  source.state.events.push(
    ...Array.from({ length: HELD_LIMIT }, (_, n) => event(31 + n)),
  );
  const step = await followFeed(feed, source.read);
  expect(step.feed.events).toHaveLength(HELD_LIMIT);
  expect(step.feed.events.at(-1)!.sequence).toBe(31);
  expect(step.feed.floor).toBe(31);
  expect(step.feed.exhausted).toBe(false);
  // The page is full, so it does not load more until the filters are narrowed.
  expect((await olderFeed(step.feed, source.read)).added).toBe(0);
});

test("scrolling back grows the tail first, then walks windows of sequences to the start of the log", async () => {
  // A sparse filter: one matching event in every 50 sequences across 20,000.
  const matching = Array.from({ length: 400 }, (_, n) =>
    event((n + 1) * 50, "lease.failed"),
  );
  const source = log(matching);
  source.state.oldest = 1;
  let feed = await openFeed(source.read);
  expect(sequences(feed.events).at(-1)).toBe(15050);
  const seen = [feed.events.length];
  for (let step = 0; step < 40 && !feed.exhausted; step++) {
    const result = await olderFeed(feed, source.read);
    expect(result.feed.floor).toBeLessThanOrEqual(feed.floor);
    feed = result.feed;
    seen.push(feed.events.length);
  }
  // Four tail reads hold all 400 matches. The fifth returns fewer than it asked for, which ends the search
  // without walking 20,000 sequences; nothing is duplicated on the way.
  expect(source.reads.slice(0, 5)).toEqual([
    "tail=100",
    "tail=200",
    "tail=300",
    "tail=400",
    "tail=500",
  ]);
  expect(seen.slice(0, 5)).toEqual([100, 200, 300, 400, 400]);
  expect(feed.exhausted).toBe(true);
  expect(sequences(feed.events)).toEqual(sequences(matching).reverse());

  // A dense log beyond the tail's reach is walked in windows, each read holding every event in it.
  const dense = log(Array.from({ length: 3000 }, (_, n) => event(n + 1)));
  let walked = await openFeed(dense.read);
  for (let step = 0; step < 4; step++)
    walked = (await olderFeed(walked, dense.read)).feed;
  expect(walked.events).toHaveLength(500);
  expect(dense.reads).toEqual([
    "tail=100",
    "tail=200",
    "tail=300",
    "tail=400",
    "tail=500",
  ]);
  const next = await olderFeed(walked, dense.read);
  expect(dense.reads.at(-1)).toBe(`after=${2501 - READ_LIMIT - 1}`);
  expect(next.added).toBe(READ_LIMIT);
  expect(next.feed.floor).toBe(2001);
  expect(sequences(next.feed.events)).toEqual(
    Array.from({ length: 1000 }, (_, n) => 3000 - n),
  );
  // The walk stops at the oldest retained event.
  dense.state.oldest = 1900;
  dense.state.events = dense.state.events.filter((e) => e.sequence >= 1900);
  const last = await olderFeed(next.feed, dense.read);
  expect(last.added).toBe(101);
  expect(last.feed.exhausted).toBe(true);
});
