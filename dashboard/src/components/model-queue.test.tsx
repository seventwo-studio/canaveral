import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ModelQueue, queuedModelJob } from "./model-queue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const digest = "sha256:" + "a".repeat(64);
const app = "4be8431f-e17b-4f15-854b-e25229f34ac1";
const waitingId = "00000000-0000-4000-8000-000000000071";
const runningId = "00000000-0000-4000-8000-000000000072";
const queued = (id: string, changes: Record<string, unknown> = {}) => ({
  id,
  applicationId: app,
  model: "fixture:latest",
  digest,
  state: "waitingForResources",
  cancelRequested: false,
  stopped: false,
  cleanup: "pending",
  assigned: false,
  reservationHeld: false,
  createdAt: 1000,
  updatedAt: 1000,
  request: {
    state: "waiting",
    priority: 5,
    deadline: "2026-12-01T12:00:00.000Z",
    reason: "capacity_unavailable",
    admittedAt: null,
  },
  ...changes,
});
const reply = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});

test("decodes queue state and refuses malformed or prompt-free invalid rows", () => {
  expect(queuedModelJob(queued(waitingId)).queue).toEqual({
    state: "waiting",
    priority: 5,
    deadline: "2026-12-01T12:00:00.000Z",
    reason: "capacity_unavailable",
  });
  expect(queuedModelJob(queued(waitingId, { request: undefined })).queue).toBe(
    undefined,
  );
  expect(() => queuedModelJob(queued("not-a-uuid"))).toThrow();
  expect(() =>
    queuedModelJob(queued(waitingId, { request: { state: "parked" } })),
  ).toThrow();
});

test("shows waiting and running jobs and cancels a waiting job with one mutation UUID", async () => {
  const cancels: Array<{ url: string; body: { id: string } }> = [];
  let closed = false;
  let lose = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/admin/model-jobs")
        return reply({
          jobs: [
            closed
              ? queued(waitingId, {
                  state: "cancelled",
                  cancelRequested: true,
                  stopped: true,
                  cleanup: "complete",
                  request: {
                    state: "cancelled",
                    priority: 5,
                    deadline: null,
                    reason: "administrator_cancelled",
                    admittedAt: null,
                  },
                })
              : queued(waitingId),
            queued(runningId, {
              state: "running",
              assigned: true,
              reservationHeld: true,
              request: undefined,
            }),
          ],
        });
      const body = JSON.parse(String(init.body));
      cancels.push({ url, body });
      // The first response is lost after the controller may have applied it.
      if (lose) {
        lose = false;
        throw new TypeError("network");
      }
      closed = true;
      return reply({
        id: waitingId,
        requestId: body.id,
        action: "cancel",
        state: "cancelled",
        applicationId: app,
      });
    }),
  );
  render(<ModelQueue onDenied={vi.fn()} />);
  await screen.findByText(
    /Waiting for admission \(no approved runner has free capacity\) · priority 5/,
  );
  expect(screen.getByText("No capacity reserved")).toBeTruthy();
  expect(screen.getByText("Capacity reserved")).toBeTruthy();
  expect(screen.getByText("1 waiting · 1 admitted or finished")).toBeTruthy();
  fireEvent.click(screen.getByText("Cancel waiting job"));
  fireEvent.click(await screen.findByText("Retry same cancellation"));
  await screen.findByText("Cancellation recorded: Cancelled.");
  await screen.findByText(
    /Cancelled before admission \(cancelled by an administrator\)/,
  );
  expect(cancels).toHaveLength(2);
  expect(cancels[0]!.url).toBe("/api/v1/admin/jobs/" + waitingId + "/cancel");
  expect(cancels[1]!.body).toEqual(cancels[0]!.body);
  expect(cancels[0]!.body).toMatchObject({ applicationId: app });
  // The running job offers cancellation, which only requests a runner stop.
  expect(screen.getByText("Cancel job")).toBeTruthy();
});

test("denial ends administrator access", async () => {
  const onDenied = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply({ error: "Forbidden." }, 403)),
  );
  render(<ModelQueue onDenied={onDenied} />);
  await screen.findByRole("alert");
  expect(onDenied).toHaveBeenCalled();
});
