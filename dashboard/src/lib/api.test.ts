import { afterEach, expect, test, vi } from "vitest";
import { api, templatesFor } from "./api";
import { operate } from "./machine-operations";
import { operationReceipt, powerOffReceipt } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("invalid mutation acknowledgements stay unknown and are not replayed", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      response({ id: "other", machineId: "machine", state: "succeeded" }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    api("machines/machine/power-off", { id: "request" }, (value) =>
      powerOffReceipt(value, { id: "request", machineId: "machine" }),
    ),
  ).rejects.toThrow("outcome may be unknown");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("typed power receipts preserve request and machine ownership", () => {
  const value = { id: "request", machineId: "machine", state: "queued" };
  expect(
    powerOffReceipt(value, { id: "request", machineId: "machine" }),
  ).toEqual(value);
  expect(() =>
    powerOffReceipt(value, { id: "request", machineId: "other" }),
  ).toThrow("ownership changed");
  expect(() => powerOffReceipt({ ...value, state: "complete" })).toThrow();
});

test("malformed operation results cannot become successful control responses", () => {
  expect(
    operationReceipt({ state: "succeeded", result: { text: "done" } }).result
      ?.text,
  ).toBe("done");
  for (const value of [
    null,
    [],
    { result: {} },
    { state: "succeeded", result: [] },
    { state: "failed", result: { detail: {} } },
  ]) {
    expect(() => operationReceipt(value)).toThrow();
  }
});

test("HTTP refusals retain their status even when the response body is not an object", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("refused", 401)));
  await expect(api("auth/session")).rejects.toMatchObject({
    status: 401,
    message: "The request could not be completed.",
  });
});

test("same-machine operations serialize while another machine remains independent", async () => {
  vi.useFakeTimers();
  const posts: Array<{ machine: string; id: string }> = [];
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (options.method === "GET")
      return response({ state: "succeeded", result: { text: "first" } });
    const body = JSON.parse(options.body as string) as { id: string };
    const machine = path.includes("/machines/a/") ? "a" : "b";
    posts.push({ machine, id: body.id });
    return response(
      posts.length === 1
        ? { state: "queued" }
        : { state: "succeeded", result: { text: machine } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const first = operate("a", "shell-write", { text: "one" });
  const second = operate("a", "shell-write", { text: "two" });
  const independent = operate("b", "shell-write", { text: "other" });
  await vi.advanceTimersByTimeAsync(0);
  expect(posts.map((post) => post.machine)).toEqual(["a", "b"]);
  await expect(independent).resolves.toEqual({ text: "b" });
  await vi.advanceTimersByTimeAsync(250);
  await expect(first).resolves.toEqual({ text: "first" });
  await expect(second).resolves.toEqual({ text: "a" });
  expect(new Set(posts.map((post) => post.id)).size).toBe(3);
});

test("a lost creation response keeps its inspection receipt and is never replayed automatically", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValue(new TypeError("Fixture transport interruption"));
  vi.stubGlobal("fetch", fetch);
  await expect(
    operate("lost", "shell-write", { text: "test" }),
  ).rejects.toThrow(
    /Operation [a-f0-9-]+; inspect this receipt before retrying/,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("image folding preserves architecture and each host's admission state", () => {
  const base = {
    id: "linux",
    revision: "4",
    arch: "arm64",
    hostId: "a",
    online: true,
    accepting: true,
  };
  const grouped = templatesFor([
    base,
    { ...base, hostId: "b", accepting: false },
    { ...base, arch: "amd64", hostId: "c" },
  ]);
  expect(grouped).toHaveLength(2);
  expect(grouped[0]?.hosts).toEqual([
    { id: "a", online: true, accepting: true },
    { id: "b", online: true, accepting: false },
  ]);
  expect(grouped[1]?.arch).toBe("amd64");
});
