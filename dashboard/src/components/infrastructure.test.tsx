import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { NamespaceObservation } from "@/lib/infrastructure";
import { InfrastructureCard, NamespaceResources } from "./infrastructure";

afterEach(cleanup);

function cluster(
  owned: NamespaceObservation["canaveral"] | null,
): NamespaceObservation {
  return {
    namespace: "guests",
    sampledAt: 1000,
    metrics: { status: "available", cpuCores: 2, memoryMiB: 1024, podCount: 4 },
    quotas: { status: "available", items: [] },
    ...(owned ? { canaveral: owned } : {}),
  };
}

describe("namespace and assigned VM observations", () => {
  it("does not invent zero usage when a quota limit has no reported usage", () => {
    const value = cluster(null);
    value.quotas.items = [
      { name: "storage", hard: { "requests.storage": 100 }, used: {} },
    ];
    const view = render(<NamespaceResources cluster={value} />);
    expect(screen.getByText(/requests.storage: Unavailable/)).toBeTruthy();
    view.unmount();
    value.quotas.items[0]!.used["requests.storage"] = 0;
    render(<NamespaceResources cluster={value} />);
    expect(screen.getByText(/requests.storage: 0 \/ 100/)).toBeTruthy();
  });

  it("keeps missing host reservation reports unavailable rather than drawing zero meters", () => {
    render(
      <InfrastructureCard
        host={{
          id: "host",
          name: "Host",
          provider: "linux",
          online: true,
          enabled: true,
          capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 },
        }}
        busy={false}
        mutate={() => {}}
        resourcesHref="#hosts/host"
      />,
    );
    expect(screen.getByText("Reservation details unavailable.")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows owned VM usage as a subset of namespace usage", () => {
    render(
      <NamespaceResources
        cluster={cluster({
          scope: "assigned-vm-pods",
          ownership: {
            status: "complete",
            assignedMachines: 1,
            verifiedMachines: 1,
          },
          metrics: {
            status: "available",
            cpuCores: 0.25,
            memoryMiB: 128,
            podCount: 2,
            sampledAt: 990,
          },
        })}
      />,
    );
    const owned = within(
      screen.getByRole("region", { name: "Canaveral VM workload usage" }),
    );
    expect(owned.getByText(/0.25 CPU cores/).textContent).toContain("128 MiB");
    expect(owned.getByText(/Verified for 1 assigned machine/)).toBeTruthy();
    expect(owned.getByText(/included in the namespace total/)).toBeTruthy();
    expect(screen.getByText(/2 CPU cores/).textContent).toContain(
      "4 measured pods",
    );
  });

  it("keeps owned usage unknown for legacy or incomplete evidence", () => {
    for (const owned of [
      null,
      {
        ownership: { status: "unavailable" },
        metrics: { status: "unavailable" },
      },
      {
        ownership: { status: "complete" },
        metrics: { status: "unavailable", coverage: { status: "incomplete" } },
      },
    ] satisfies Array<NamespaceObservation["canaveral"] | null>) {
      const view = render(<NamespaceResources cluster={cluster(owned)} />);
      const usage = within(
        screen.getByRole("region", { name: "Canaveral VM workload usage" }),
      );
      expect(usage.getByText(/Canaveral VM usage unavailable/)).toBeTruthy();
      expect(usage.queryByText(/0 CPU cores/)).toBeNull();
      expect(screen.getByText(/2 CPU cores/)).toBeTruthy();
      view.unmount();
    }
  });
});
