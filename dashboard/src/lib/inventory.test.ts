import { expect, test } from "vitest";
import {
  authStatus,
  createdMachine,
  hostsResponse,
  imagesResponse,
  loginReceipt,
  machinesResponse,
} from "./inventory";

const amounts = { cpu: 2, memoryMiB: 4096, diskGiB: 32 };
const image = {
  id: "linux",
  revision: "1",
  os: "linux",
  arch: "arm64",
  mode: "headless",
  hostId: "host",
  online: true,
  accepting: false,
  minimum: amounts,
};
const host = {
  id: "host",
  name: "Host",
  provider: "linux",
  platform: null,
  online: false,
  enabled: true,
  capacity: amounts,
  health: null,
  usage: null,
};
const machine = {
  id: "machine",
  name: "Guest",
  hostId: "host",
  templateId: "linux",
  template: image,
  resources: amounts,
  desired: "stopped",
  observed: "unknown",
  preparation: { state: "pending" },
  capabilities: { files: true, shell: true, desktopStream: false },
};

test("inventory preserves offline hosts, withheld image admission and unknown guest state", () => {
  expect(hostsResponse({ hosts: [host] })[0]).toMatchObject({
    online: false,
    health: undefined,
    usage: undefined,
  });
  expect(imagesResponse({ templates: [image] })[0]?.accepting).toBe(false);
  expect(machinesResponse({ machines: [machine] })[0]).toMatchObject({
    observed: "unknown",
    capabilities: machine.capabilities,
  });
});
test("malformed inventory collections and capabilities are not accepted as empty inventory", () => {
  expect(() => hostsResponse({})).toThrow();
  expect(() =>
    hostsResponse({ hosts: [{ ...host, online: "true" }] }),
  ).toThrow();
  expect(() =>
    machinesResponse({
      machines: [{ ...machine, capabilities: { shell: "yes" } }],
    }),
  ).toThrow();
  expect(() =>
    imagesResponse({ templates: [{ ...image, memoryStepMiB: 0 }] }),
  ).toThrow();
});
test("namespace totals require complete measurements and owned usage requires ownership evidence", () => {
  const metrics = {
    status: "available",
    cpuCores: 1,
    memoryMiB: 512,
    podCount: 1,
    coverage: { status: "complete", activePods: 1, measuredPods: 1 },
  };
  const cluster = {
    namespace: "guests",
    sampledAt: 1000,
    metrics,
    quotas: { status: "available", items: [] },
  };
  const usage = {
    scope: "runner",
    fresh: true,
    receivedAt: 1000,
    cpuPercent: null,
    cluster,
  };
  expect(
    hostsResponse({ hosts: [{ ...host, usage }] })[0]?.usage?.cpuPercent,
  ).toBeNull();
  expect(() =>
    hostsResponse({
      hosts: [
        {
          ...host,
          usage: {
            ...usage,
            cluster: {
              ...cluster,
              metrics: {
                ...metrics,
                coverage: {
                  status: "incomplete",
                  activePods: 2,
                  measuredPods: 1,
                },
              },
            },
          },
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    hostsResponse({
      hosts: [
        {
          ...host,
          usage: {
            ...usage,
            cluster: {
              ...cluster,
              canaveral: {
                scope: "assigned-vm-pods",
                ownership: { status: "unavailable" },
                metrics,
              },
            },
          },
        },
      ],
    }),
  ).toThrow();
});
test("authentication accepts an explicit user and rejects truthy malformed setup flags or login receipts", () => {
  expect(authStatus({ setupRequired: true, setupAllowed: false })).toEqual({
    setupRequired: true,
    setupAllowed: false,
    user: undefined,
  });
  expect(loginReceipt({ user: { username: "operator" } })).toEqual({
    user: { username: "operator" },
  });
  expect(() => authStatus({ setupRequired: "false" })).toThrow();
  expect(() => loginReceipt({ user: {} })).toThrow();
});
test("creation confirmation cannot substitute another machine for the original request", () => {
  expect(
    createdMachine({ id: "request", name: "Guest", hostId: "host" }, "request")
      .id,
  ).toBe("request");
  expect(() =>
    createdMachine({ id: "other", name: "Guest", hostId: "host" }, "request"),
  ).toThrow("Inspect the original request");
});
