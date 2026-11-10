import { expect, test } from "vitest";
import {
  allocationLimits,
  hostLimitReceipt,
  connectionSetups,
  resourceDetails,
  runnerBindings,
  setupReceipt,
  setupRevocation,
} from "./infrastructure";

const amounts = { cpu: 8, memoryMiB: 8192, diskGiB: 100 };
const report = () => ({
  hostId: "host",
  capacity: amounts,
  limits: amounts,
  categories: [
    {
      id: "retainedDisks",
      label: "Stopped disks",
      cpu: 0,
      memoryMiB: 0,
      diskGiB: 32,
    },
  ],
  allocations: [
    {
      id: "machine",
      name: "Stopped VM",
      observed: "stopped",
      resources: amounts,
      computeReserved: false,
    },
  ],
  images: [
    {
      id: "image",
      revision: "1",
      os: "linux",
      arch: "arm64",
      bytes: null,
      offered: false,
    },
  ],
  samples: [
    { receivedAt: 1000, cpuPercent: null },
    { receivedAt: 990, cpuPercent: 0 },
  ],
});

test("resource reports preserve retained reservations, unknown samples and withdrawn images", () => {
  const data = resourceDetails(report(), "host");
  expect(data.categories?.[0]?.diskGiB).toBe(32);
  expect(data.allocations[0]?.computeReserved).toBe(false);
  expect(data.samples.map((s) => s.cpuPercent)).toEqual([null, 0]);
  expect(data.images?.[0]?.offered).toBe(false);
});
test("missing installed-image and category reports stay unknown rather than becoming empty measurements", () => {
  const { images: _images, categories: _categories, ...partial } = report();
  const data = resourceDetails(partial, "host");
  expect(data.images).toBeUndefined();
  expect(data.categories).toBeUndefined();
});
test("cross-host or malformed resource reports cannot replace the selected host's last report", () => {
  const r = report();
  for (const value of [
    { ...r, hostId: "other" },
    { ...r, categories: [...r.categories, ...r.categories] },
    { ...r, samples: [{ receivedAt: 1000, cpuPercent: "0" }] },
    { ...r, limits: { ...amounts, diskGiB: -1 } },
  ])
    expect(() => resourceDetails(value, "host")).toThrow();
});
test("advanced runtime bindings retain image configuration and reject non-object runtime bindings", () => {
  const config = {
    storage: "/guests",
    templates: [{ id: "linux" }],
    runtimes: { libvirt: { uri: "qemu:///system" } },
    custom: { retained: true },
  };
  expect(runnerBindings(config)).toEqual(config);
  for (const value of [
    null,
    [],
    { runtimes: [] },
    { runtimes: { libvirt: null } },
  ])
    expect(() => runnerBindings(value)).toThrow();
});
test("one-time setup and revocation receipts must acknowledge the original request", () => {
  const issued = {
    id: "setup",
    enrollmentToken: "fixture-secret",
    expiresAt: 1000,
  };
  expect(setupReceipt(issued, "setup")).toEqual(issued);
  for (const value of [
    { ...issued, id: "other" },
    { ...issued, enrollmentToken: null },
    { ...issued, expiresAt: Infinity },
  ])
    expect(() => setupReceipt(value, "setup")).toThrow();
  expect(
    setupRevocation({ id: "setup", state: "revoked" }, "setup"),
  ).toBeUndefined();
  expect(() =>
    setupRevocation({ id: "other", state: "revoked" }, "setup"),
  ).toThrow();
  expect(
    connectionSetups({
      setups: [
        {
          id: "setup",
          name: "Host",
          provider: "linux",
          state: "expired",
          expiresAt: 1000,
          hostId: null,
        },
      ],
    }).setups[0]?.state,
  ).toBe("expired");
});

test("host limits require matching save amounts and respect a smaller host offer", () => {
  const limits = { ...amounts, cpu: 4 };
  expect(hostLimitReceipt({ hostId: "host", limits }, "host", limits)).toEqual(
    limits,
  );
  expect(() =>
    hostLimitReceipt({ hostId: "host", limits: amounts }, "host", limits),
  ).toThrow();
  expect(allocationLimits({ capacity: amounts, limits })).toEqual(limits);
  expect(allocationLimits({ capacity: limits, limits: amounts })).toEqual(
    limits,
  );
});
