import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ModelRuns, modelJob } from "./model-runs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
const digest = "sha256:" + "a".repeat(64);
const other = "sha256:" + "b".repeat(64);
const host = "4be8431f-e17b-4f15-854b-e25229f34ac1";
const offer = (changes = {}) => ({
  id: "fixture:latest",
  digest,
  capability: "generation",
  resources: { cpu: 2, memoryMiB: 2048, diskGiB: 1 },
  hostId: host,
  online: true,
  accepting: true,
  ...changes,
});
const job = (id: string, changes: Record<string, unknown> = {}) => ({
  id,
  hostId: host,
  model: "fixture:latest",
  definition: offer(),
  desired: "running",
  state: "queued",
  detail: "",
  updatedAt: 1000,
  stopped: false,
  cleanup: "pending",
  reservationHeld: true,
  sequence: 0,
  ...changes,
});
const reply = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});

test("retries the same request, follows it to output and shows released capacity", async () => {
  const bodies: string[] = [];
  let id = "";
  let current: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/models")
        return reply({
          models: [
            offer(),
            offer({ hostId: "other-host", online: false }),
            offer({ id: "offline:latest", digest: other, accepting: false }),
          ],
        });
      if (url === "/api/v1/jobs" && init.method === "POST") {
        bodies.push(String(init.body));
        id = JSON.parse(bodies[0]!).id;
        if (bodies.length === 1) throw Error("disconnected");
        current = job(id);
        return reply(current);
      }
      if (url === "/api/v1/jobs") return reply({ jobs: [] });
      expect(url).toBe("/api/v1/jobs/" + id);
      return reply(current);
    }),
  );
  render(<ModelRuns onDenied={vi.fn()} />);
  await screen.findByText("No model jobs yet.");
  const select = screen.getByLabelText("Installed model") as HTMLSelectElement;
  const options = Array.from(select.options);
  // Offers for the same exact identity collapse to one choice.
  expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
    ["fixture:latest · sha256:aaaaaaaaaaaa · 1 ready host", false],
    ["offline:latest · sha256:bbbbbbbbbbbb · no ready host", true],
  ]);
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "Say hello" },
  });
  fireEvent.change(screen.getByLabelText("Maximum output tokens"), {
    target: { value: "32" },
  });
  fireEvent.click(screen.getByText("Run model"));
  await screen.findByText(/outcome may be unknown/);
  fireEvent.click(screen.getByText("Retry same request"));
  await screen.findByText("Queued");
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0]!)).toEqual({
    id,
    model: "fixture:latest",
    digest,
    prompt: "Say hello",
    maxTokens: 32,
  });
  expect(screen.getByText("Capacity reserved")).toBeTruthy();
  current = job(id, {
    state: "succeeded",
    stopped: true,
    cleanup: "complete",
    reservationHeld: false,
    sequence: 3,
    result: {
      model: "fixture:latest",
      text: "Hello from the model",
      usage: { inputTokens: 4, outputTokens: 5 },
    },
  });
  await screen.findByText("Hello from the model", undefined, {
    timeout: 4000,
  });
  expect(screen.getByText("4 input tokens · 5 output tokens")).toBeTruthy();
  expect(screen.getByText("Runtime stopped · capacity released")).toBeTruthy();
  expect(screen.queryByText("Cancel job")).toBeNull();
});

test("cancels a running job and keeps polling until the runner confirms stop", async () => {
  const id = "00000000-0000-4000-8000-000000000051";
  let current = job(id, { state: "running" });
  const cancels: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/models") return reply({ models: [offer()] });
      if (url === "/api/v1/jobs") return reply({ jobs: [current] });
      if (url.endsWith("/cancel")) {
        cancels.push(String(init.body));
        current = job(id, { state: "running", desired: "cancelled" });
        return reply(current);
      }
      return reply(current);
    }),
  );
  render(<ModelRuns onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByText("Cancel job"));
  await screen.findByText("Running · Cancellation requested");
  expect(cancels).toEqual(["{}"]);
  expect(screen.queryByText("Cancel job")).toBeNull();
  current = job(id, {
    state: "cancelled",
    desired: "cancelled",
    stopped: true,
    cleanup: "complete",
    reservationHeld: false,
  });
  await screen.findByText("Runtime stopped · capacity released", undefined, {
    timeout: 4000,
  });
  expect(screen.getByText("Cancelled")).toBeTruthy();
});

test("loads output for finished jobs only on request", async () => {
  const id = "00000000-0000-4000-8000-000000000052";
  const done = {
    state: "succeeded",
    stopped: true,
    cleanup: "complete",
    reservationHeld: false,
  };
  const fetch = vi.fn(async (url: string) => {
    if (url === "/api/v1/models") return reply({ models: [] });
    if (url === "/api/v1/jobs") return reply({ jobs: [job(id, done)] });
    return reply(
      job(id, {
        ...done,
        result: {
          model: "fixture:latest",
          text: "Stored answer",
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(<ModelRuns onDenied={vi.fn()} />);
  await screen.findByText("No host offers an installed model.");
  expect((screen.getByText("Run model") as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(await screen.findByText("Show output"));
  await screen.findByText("Stored answer");
  expect(fetch.mock.calls.map(([url]) => url)).toContain("/api/v1/jobs/" + id);
});

test("a definite rejection discards the request identity and denial ends admin access", async () => {
  const onDenied = vi.fn();
  const posts: string[] = [];
  let status = 409;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/models") return reply({ models: [offer()] });
      if (url === "/api/v1/jobs" && init.method === "POST") {
        posts.push(JSON.parse(String(init.body)).id);
        return reply(
          {
            error:
              status === 409
                ? "No online accepting host offers this model and enough unreserved capacity."
                : "Admin required.",
          },
          status,
        );
      }
      return reply({ jobs: [] });
    }),
  );
  render(<ModelRuns onDenied={onDenied} />);
  await screen.findByText("No model jobs yet.");
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "Hello" },
  });
  fireEvent.click(screen.getByText("Run model"));
  await screen.findByText(/enough unreserved capacity/);
  expect(screen.getByText("Run model")).toBeTruthy();
  status = 403;
  fireEvent.click(screen.getByText("Run model"));
  await screen.findByText("Admin required.");
  expect(posts).toHaveLength(2);
  expect(posts[0]).not.toBe(posts[1]);
  expect(onDenied).toHaveBeenCalledTimes(1);
});

test("rejects malformed or mismatched job responses", () => {
  const id = "00000000-0000-4000-8000-000000000053";
  expect(() =>
    modelJob(job(id), "00000000-0000-4000-8000-000000000054"),
  ).toThrow();
  expect(() => modelJob(job(id, { state: "done" }))).toThrow();
  expect(() =>
    modelJob(
      job(id, {
        state: "running",
        result: { text: "x", usage: { inputTokens: 1, outputTokens: 1 } },
      }),
    ),
  ).toThrow();
  expect(() =>
    modelJob(
      job(id, {
        state: "succeeded",
        result: { text: "x", usage: { inputTokens: -1, outputTokens: 1 } },
      }),
    ),
  ).toThrow();
});

test("claims released capacity only after a terminal, stopped and cleaned job", async () => {
  const id = "00000000-0000-4000-8000-000000000061";
  // An inconsistent response must not be shown as released.
  const inconsistent = job(id, { state: "running", reservationHeld: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/v1/models"
        ? reply({ models: [offer()] })
        : reply({ jobs: [inconsistent] }),
    ),
  );
  render(<ModelRuns onDenied={vi.fn()} />);
  await screen.findByText("Capacity reserved");
  expect(screen.queryByText("Runtime stopped · capacity released")).toBeNull();
});

test("keeps an uncertain request identity across reloads until it is retried or discarded", async () => {
  sessionStorage.clear();
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/models") return reply({ models: [offer()] });
      if (url === "/api/v1/jobs" && init.method === "POST") {
        posts.push(String(init.body));
        return reply({ error: "Controller unavailable." }, 503);
      }
      return reply({ jobs: [] });
    }),
  );
  const first = render(<ModelRuns onDenied={vi.fn()} />);
  await screen.findByText(/fixture:latest/);
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "Hello" },
  });
  fireEvent.click(screen.getByText("Run model"));
  await screen.findByText("Retry same request");
  first.unmount();
  render(<ModelRuns onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByText("Retry same request"));
  await vi.waitFor(() => expect(posts).toHaveLength(2));
  expect(JSON.parse(posts[1]!).id).toBe(JSON.parse(posts[0]!).id);
  fireEvent.click(await screen.findByText("Discard request"));
  expect(await screen.findByText("Run model")).toBeTruthy();
  expect(sessionStorage.getItem("canaveral.modelRuns.pending")).toBeNull();
});

test("a followed job resumes polling after a transient error", async () => {
  const id = "00000000-0000-4000-8000-000000000062";
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/models") return reply({ models: [offer()] });
      if (url === "/api/v1/jobs" && init.method !== "POST")
        return reply({ jobs: [job(id, { state: "running" })] });
      if (url.endsWith("/cancel"))
        return reply(job(id, { state: "running", desired: "cancelled" }));
      calls++;
      if (calls === 1) throw new TypeError("network");
      return reply(
        job(id, {
          state: "cancelled",
          desired: "cancelled",
          stopped: true,
          cleanup: "complete",
          reservationHeld: false,
        }),
      );
    }),
  );
  render(<ModelRuns onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByText("Cancel job"));
  await screen.findByText("Runtime stopped · capacity released", undefined, {
    timeout: 6000,
  });
}, 10000);
