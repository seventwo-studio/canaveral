import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { FleetPulse, machineDistribution } from "./fleet-pulse";
import type { Inventory, Machine } from "@/lib/inventory";
import type { Host } from "@/lib/infrastructure";

afterEach(cleanup);
const machine = (observed: string, state = "ready", ready = false) =>
  ({ observed, preparation: { state }, ready }) as Machine;
const inventory: Inventory = {
  machines: [
    machine("running", "ready", true),
    machine("running", "pending"),
    machine("running", "failed"),
    machine("stopped"),
    machine("restoring"),
  ],
  hosts: [
    {
      id: "h",
      name: "Host",
      provider: "macos",
      online: false,
      enabled: true,
      capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 64 },
      limits: { cpu: 4, memoryMiB: 4096, diskGiB: 64 },
      reserved: { cpu: 6, memoryMiB: 2048, diskGiB: 0 },
    } as Host,
  ],
  templates: [],
};
it("partitions machines once, separates preparation failures and preserves new states", () => {
  const rows = machineDistribution(inventory);
  expect(rows).toEqual([
    { label: "Ready", count: 1 },
    { label: "Preparing", count: 1 },
    { label: "Stopped", count: 1 },
    { label: "Setup failed", count: 1 },
    { label: "Restoring", count: 1 },
  ]);
  expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(
    inventory.machines.length,
  );
});
it("keeps offline reservations, effective limits and over-limit amounts visible in stale snapshots", () => {
  render(<FleetPulse inventory={inventory} loaded stale showHosts />);
  expect(screen.getByText("Last snapshot")).toBeTruthy();
  expect(screen.getByText("Offline")).toBeTruthy();
  const meter = screen.getByRole("meter", { name: "Host CPU reserved" });
  expect(meter.getAttribute("value")).toBe("6");
  expect(screen.getByText("6 / 4")).toBeTruthy();
  expect(screen.getByText("Over limit")).toBeTruthy();
});
it("does not turn unavailable inventory or missing reservations into zeros", () => {
  const { rerender } = render(
    <FleetPulse inventory={inventory} loaded={false} stale={false} showHosts />,
  );
  expect(screen.queryByRole("meter")).toBeNull();
  expect(
    screen.queryByRole("list", { name: "Machine state distribution" }),
  ).toBeNull();
  rerender(
    <FleetPulse
      inventory={{
        ...inventory,
        hosts: inventory.hosts.map(({ reserved, ...host }) => host),
      }}
      loaded
      stale={false}
      showHosts
    />,
  );
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.getAllByText("Unavailable")).toHaveLength(3);
});
it("keeps infrastructure out of the personal workspace", () => {
  render(<FleetPulse inventory={inventory} loaded stale={false} />);
  const region = screen.getByRole("region", { name: "Fleet pulse" });
  expect(within(region).queryByText("Host reservations")).toBeNull();
});

it("keeps charts scoped to the full snapshot while emitting exact-state filters", async () => {
  const onSelectState = vi.fn();
  render(
    <FleetPulse
      inventory={inventory}
      loaded
      stale={false}
      onSelectState={onSelectState}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Filter preparing machines: 1" }),
  );
  expect(onSelectState).toHaveBeenCalledWith("preparing");
  expect(screen.getByRole("img", { name: "5 machines by state" })).toBeTruthy();
  expect(screen.getByText("Before filters")).toBeTruthy();
});
it("bounds the host summary and brings exceptions ahead of healthy connections", async () => {
  const hosts = Array.from({ length: 8 }, (_, i) => ({
    ...inventory.hosts[0]!,
    id: `h-${i}`,
    name: `Host ${i}`,
    online: i !== 7,
  }));
  render(
    <FleetPulse
      inventory={{ ...inventory, hosts }}
      loaded
      stale={false}
      showHosts
    />,
  );
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(3);
  expect(links[0]?.textContent).toBe("Host 7");
  await userEvent.click(
    screen.getByRole("button", { name: "Show all 8 connections" }),
  );
  expect(screen.getAllByRole("link")).toHaveLength(8);
  await userEvent.click(
    screen.getByRole("button", { name: "Show fewer connections" }),
  );
  expect(screen.getAllByRole("link")).toHaveLength(3);
});
