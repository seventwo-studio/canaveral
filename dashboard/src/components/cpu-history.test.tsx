import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Host, ResourceSample } from "@/lib/infrastructure";
import { CpuHistory, cpuHistoryWindow } from "./cpu-history";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const now = 1794949200;
const host: Pick<Host, "online" | "usage"> = {
  online: true,
  usage: { scope: "host", fresh: true, receivedAt: now },
};
const freezeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now * 1000));
};

it("plots actual sample time spacing and CPU values, including timestamp zero and zero percent", () => {
  const { container } = render(
    <CpuHistory
      host={host}
      samples={[
        { receivedAt: 40, cpuPercent: 100 },
        { receivedAt: 10, cpuPercent: 25 },
        { receivedAt: 0, cpuPercent: 0 },
      ]}
    />,
  );
  expect(
    screen.getByRole("img", { name: /CPU utilization history/ }),
  ).toBeTruthy();
  const zero = container.querySelector('circle[data-time="0"]');
  const quarter = container.querySelector('circle[data-time="10"]');
  const full = container.querySelector('circle[data-time="40"]');
  expect(zero?.getAttribute("cy")).toBe("100%");
  expect(full?.getAttribute("cy")).toBe("0%");
  expect(quarter?.getAttribute("cy")).toBe("75%");
  expect(zero?.getAttribute("cx")).toBe("0%");
  expect(quarter?.getAttribute("cx")).toBe("25%");
  expect(full?.getAttribute("cx")).toBe("100%");
  expect(
    container.querySelector('time[datetime="1970-01-01T00:00:00.000Z"]'),
  ).toBeTruthy();
  expect(screen.getByText("100%", { selector: "span" })).toBeTruthy();
  expect(screen.getByText("50%")).toBeTruthy();
});

it("leaves missing and invalid CPU readings unmeasured rather than filling a zero or joining a gap", () => {
  const { container } = render(
    <CpuHistory
      host={host}
      samples={[
        { receivedAt: 0, cpuPercent: 0 },
        { receivedAt: 10, cpuPercent: null },
        { receivedAt: 20 },
        { receivedAt: 30, cpuPercent: Number.NaN },
        { receivedAt: 40, cpuPercent: 110 },
        { receivedAt: 50, cpuPercent: 100 },
      ]}
    />,
  );
  expect(container.querySelectorAll("circle")).toHaveLength(2);
  expect(container.querySelector("polyline, path")).toBeNull();
  expect(screen.getByText(/2 measured · 4 unavailable/)).toBeTruthy();
  const table = container.querySelector("table");
  expect(table?.querySelectorAll("tbody tr")).toHaveLength(6);
  expect(table?.textContent?.match(/Unavailable/g)).toHaveLength(4);
});

it("requires two valid readings without hiding an available single measurement", () => {
  const { rerender, container } = render(
    <CpuHistory host={host} samples={[]} />,
  );
  expect(screen.getByText(/Not enough samples/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  rerender(
    <CpuHistory
      host={host}
      samples={[
        { receivedAt: 0, cpuPercent: 0 },
        { receivedAt: 10, cpuPercent: null },
      ]}
    />,
  );
  expect(screen.getByText(/Not enough samples/)).toBeTruthy();
  expect(container.querySelector("table")?.textContent).toContain("0%");
  expect(screen.queryByRole("img")).toBeNull();
});

it("keeps the latest 60 reports in timestamp order while retaining missing readings", () => {
  const samples: ResourceSample[] = Array.from(
    { length: 75 },
    (_, receivedAt) => ({
      receivedAt,
      cpuPercent: receivedAt === 74 ? null : 25,
    }),
  ).reverse();
  const sorted = cpuHistoryWindow([
    ...samples,
    { receivedAt: -1, cpuPercent: 25 },
    { receivedAt: Infinity, cpuPercent: 25 },
  ]);
  expect(sorted).toHaveLength(60);
  expect(sorted[0]?.receivedAt).toBe(15);
  expect(sorted.at(-1)).toEqual({ receivedAt: 74, cpuPercent: null });
  expect(samples[0]?.receivedAt).toBe(74);
});

it("labels stale, offline and retained reports without presenting them as live", () => {
  freezeTime();
  const samples = [
    { receivedAt: now - 10, cpuPercent: 20 },
    { receivedAt: now, cpuPercent: 30 },
  ];
  const { rerender } = render(
    <CpuHistory host={host} samples={samples} stale />,
  );
  expect(screen.getByText("Stale samples")).toBeTruthy();
  rerender(<CpuHistory host={{ ...host, online: false }} samples={samples} />);
  expect(screen.getByText("Host offline · last samples")).toBeTruthy();
  rerender(
    <CpuHistory
      host={host}
      samples={samples.map((s) => ({ ...s, receivedAt: s.receivedAt - 31 }))}
    />,
  );
  expect(screen.getByText("Stale samples")).toBeTruthy();
  rerender(
    <CpuHistory
      host={{ ...host, usage: { ...host.usage!, fresh: false } }}
      samples={samples}
    />,
  );
  expect(screen.getByText("Stale samples")).toBeTruthy();
  expect(screen.queryByText(/\bLive\b/)).toBeNull();
});

it("preserves runner vs physical scope and treats missing scope as unknown", () => {
  freezeTime();
  const samples = [
    { receivedAt: now - 10, cpuPercent: 20 },
    { receivedAt: now, cpuPercent: 30 },
  ];
  const { rerender } = render(<CpuHistory host={host} samples={samples} />);
  expect(
    screen.getByText("Physical host CPU · includes other workloads"),
  ).toBeTruthy();
  expect(screen.getByText("Reported samples")).toBeTruthy();
  rerender(
    <CpuHistory
      host={{ ...host, usage: { ...host.usage!, scope: "runner" } }}
      samples={samples}
    />,
  );
  expect(screen.getByText("Runner CPU · not cluster capacity")).toBeTruthy();
  rerender(<CpuHistory host={{ online: true }} samples={samples} />);
  expect(screen.getByText("CPU scope not reported")).toBeTruthy();
});

it("keeps loading distinct from insufficient measured history", () => {
  render(<CpuHistory host={host} samples={[]} loading />);
  expect(screen.getByRole("status").textContent).toContain(
    "Loading CPU samples",
  );
  expect(screen.queryByText(/Not enough samples/)).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
});
