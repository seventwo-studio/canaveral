import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HostLimits } from "./host-limits";

const host = {
  id: "host",
  name: "Linux",
  provider: "linux",
  online: true,
  enabled: true,
  capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 },
  limits: { cpu: 4, memoryMiB: 4096, diskGiB: 50 },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("saving limits requires a matching host and matching amounts; uncertain saves are never replayed", async () => {
  const requests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/hosts/host/limits");
      const body = JSON.parse(String(init.body)) as {
        limits: typeof host.limits;
      };
      requests.push(body);
      return {
        ok: true,
        json: async () => ({
          hostId: requests.length === 1 ? "other" : host.id,
          ...body,
        }),
      };
    }),
  );
  const refreshed = vi.fn();
  render(<HostLimits host={host} onRefresh={refreshed} />);
  expect(screen.getByLabelText("vCPUs").getAttribute("value")).toBe("4");
  fireEvent.change(screen.getByLabelText("vCPUs"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save host limits" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(requests).toHaveLength(1);
  expect(refreshed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save host limits" }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
  expect(requests).toEqual(
    Array(2).fill({ limits: { ...host.limits, cpu: 2 } }),
  );
  expect(screen.getByRole("status").textContent).toBe("Host limits saved.");
  expect((screen.getByLabelText("vCPUs") as HTMLInputElement).value).toBe("2");
});

test("inventory refreshes update pristine fields and preserve an in-progress edit", () => {
  const view = render(<HostLimits host={host} onRefresh={() => {}} />);
  view.rerender(
    <HostLimits
      host={{ ...host, limits: { ...host.limits, cpu: 3 } }}
      onRefresh={() => {}}
    />,
  );
  expect((screen.getByLabelText("vCPUs") as HTMLInputElement).value).toBe("3");
  fireEvent.change(screen.getByLabelText("vCPUs"), { target: { value: "" } });
  view.rerender(<HostLimits host={host} onRefresh={() => {}} />);
  expect((screen.getByLabelText("vCPUs") as HTMLInputElement).value).toBe("");
});
