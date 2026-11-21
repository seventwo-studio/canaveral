import { expect, test } from "vitest";
import { queueView, unorderedReason, waitingReason } from "./queue";
import type { QueueRequest } from "./queue";

const app = "9415f91b-569d-4d93-a09d-8f7f903a8463";
const request = {
  id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f11",
  applicationId: app,
  applicationName: "Build agent",
  kind: "lease",
  position: 1,
  reason: "capacity_unavailable",
  priority: 0,
  createdAt: "2026-11-21T09:10:41.000Z",
  deadline: null,
  label: "checkout-flow",
  template: { id: "pixel-8", revision: "3", arch: "arm64" },
  platform: "android",
};
const lease = {
  id: "b7682a27-b32e-472a-8a4d-f54a98a6d962",
  ledger: "generic",
  applicationId: app,
  name: "nightly-run",
  state: "ready",
  createdAt: "2026-11-21T08:50:00.000Z",
  expiresAt: "2026-11-21T09:20:00Z",
};
const view = {
  observedAt: "2026-11-21T09:14:03.512Z",
  limit: 500,
  requests: [request],
  waitingTotal: 1,
  leases: [lease],
  activeTotal: 1,
};

test("the queue view keeps identifiers and queue state and drops everything else", () => {
  const decoded = queueView({
    ...view,
    requests: [{ ...request, intent: { secret: "x" }, credential: "secret" }],
    leases: [{ ...lease, members: [{ machineId: "m" }] }],
  });
  expect(decoded.requests).toEqual([request]);
  expect(decoded.leases).toEqual([lease]);
  expect(decoded.waitingTotal).toBe(1);
});

test("a malformed queue view is refused whole", () => {
  for (const broken of [
    { ...view, observedAt: "now" },
    { ...view, waitingTotal: -1 },
    { ...view, requests: null },
    { ...view, requests: [{ ...request, id: "request" }] },
    { ...view, requests: [{ ...request, kind: "browser" }] },
    { ...view, requests: [{ ...request, position: 0 }] },
    { ...view, requests: [{ ...request, reason: "Free text, not a code" }] },
    { ...view, requests: [{ ...request, deadline: "tomorrow" }] },
    { ...view, requests: [{ ...request, template: { id: "pixel-8" } }] },
    { ...view, requests: [request, request] },
    { ...view, leases: [{ ...lease, ledger: "other" }] },
    { ...view, leases: [{ ...lease, expiresAt: 1800000000 }] },
    { ...view, leases: [lease, lease] },
  ])
    expect(() => queueView(broken)).toThrow();
});

test("requests must arrive in attempt order, positioned before unpositioned", () => {
  const second = {
    ...request,
    id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f12",
    position: 2,
  };
  const model = {
    ...request,
    id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f13",
    kind: "model-job",
    position: null,
  };
  expect(
    queueView({ ...view, requests: [request, second, model] }).requests.map(
      (r) => r.position,
    ),
  ).toEqual([1, 2, null]);
  expect(() => queueView({ ...view, requests: [second, request] })).toThrow(
    "attempt order",
  );
  expect(() => queueView({ ...view, requests: [model, request] })).toThrow(
    "attempt order",
  );
  // The same request UUID under two applications is two requests.
  const other = {
    ...second,
    id: request.id,
    applicationId: "9415f91b-569d-4d93-a09d-8f7f903a8464",
  };
  expect(
    queueView({ ...view, requests: [request, other] }).requests,
  ).toHaveLength(2);
});

test("every refusal code has plain words, and an unknown code is not explained away", () => {
  const decoded = queueView(view).requests[0]!;
  const reason = (extra: Partial<QueueRequest>) =>
    waitingReason({ ...decoded, ...extra });
  expect(reason({})).toBe("No eligible host has free capacity for it");
  expect(reason({ reason: "limit_exceeded" })).toContain("limits");
  expect(reason({ reason: "host_draining" })).toContain("drain");
  expect(reason({ reason: "unavailable" })).toContain(
    "No host offers this image",
  );
  expect(reason({ reason: "admission_error" })).toContain("tries again");
  expect(reason({ reason: null })).toBe("Not tried yet since it was submitted");
  expect(reason({ reason: "something_new" })).toBe(
    "Refused with a code this page has no words for",
  );
  expect(reason({ kind: "model-job", reason: "capacity_unavailable" })).toBe(
    "No approved runner has free capacity for it",
  );
  expect(reason({ kind: "model-job", reason: null })).toContain(
    "runner to claim",
  );
});

test("a missing position is explained by its cause", () => {
  const decoded = queueView(view).requests[0]!;
  const now = Date.parse("2026-11-21T09:14:03Z");
  expect(
    unorderedReason({ ...decoded, kind: "model-job", position: null }, now),
  ).toContain("No single order");
  expect(
    unorderedReason(
      { ...decoded, position: null, deadline: "2026-11-21T09:14:00Z" },
      now,
    ),
  ).toContain("Past its deadline");
  expect(
    unorderedReason(
      { ...decoded, position: null, deadline: "2026-11-21T10:00:00Z" },
      now,
    ),
  ).toBe("No position reported");
});
