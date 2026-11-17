import { expect, it } from "vitest";
import { matchesMachineState, stateFilter, hostIssue } from "./fleet";
import type { Host } from "./infrastructure";
it("matches exact chart states without confusing running preparation with readiness", () => {
  const ready = {
    observed: "running",
    ready: true,
    preparation: { state: "ready" },
  };
  const preparing = {
    observed: "running",
    ready: false,
    preparation: { state: "pending" },
  };
  const failed = {
    observed: "running",
    ready: false,
    preparation: { state: "failed" },
  };
  const running = {
    observed: "running",
    ready: false,
    preparation: { state: "ready" },
  };
  expect(
    [ready, preparing, failed, running].filter((m) =>
      matchesMachineState(m, "running"),
    ),
  ).toHaveLength(4);
  for (const [machine, label] of [
    [ready, "Ready"],
    [preparing, "Preparing"],
    [failed, "Setup failed"],
    [running, "Running"],
  ] as const) {
    expect(
      [ready, preparing, failed, running].filter((m) =>
        matchesMachineState(m, stateFilter(label)),
      ),
    ).toEqual([machine]);
  }
  expect(matchesMachineState(failed, "attention")).toBe(true);
  expect(matchesMachineState(preparing, "attention")).toBe(false);
});
it("never calls failed, stale or offline hosts healthy", () => {
  const host = { online: true, enabled: true } as Host;
  expect(hostIssue(host)).toBeNull();
  expect(
    hostIssue({ ...host, health: { status: "passed", fresh: false } }),
  ).toBe("Checks stale");
  expect(hostIssue({ ...host, online: false })).toBe("Offline");
  expect(
    hostIssue({ ...host, health: { status: "failed", fresh: true } }),
  ).toBe("Checks failed");
});
