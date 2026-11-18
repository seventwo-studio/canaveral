import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BrowserLaunch } from "./browser-launch";

const host = {
  id: "mac",
  name: "Mac",
  provider: "macos",
  platform: "macos",
  online: true,
  enabled: true,
  placementReady: true,
  runtimes: ["browser"],
  capacity: { cpu: 1, memoryMiB: 1024, diskGiB: 1 },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each([
  { online: false },
  { enabled: false },
  { placementReady: false },
  { runtimes: [] },
])("hides launch for ineligible hosts %o", (change) => {
  render(<BrowserLaunch host={{ ...host, ...change }} />);
  expect(screen.queryByRole("button")).toBeNull();
});

test("recovers an uncertain launch with the same UUID and inspects and closes the browser", async () => {
  let id = "";
  const collection = "/api/v1/hosts/mac/browsers";
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      expect(url).toBe(collection);
      const body = JSON.parse(String(init.body));
      if (!id) {
        expect(body.id).toMatch(/^[a-f0-9-]{36}$/);
        id = body.id;
        throw new Error("Disconnected");
      }
      expect(body).toEqual({ id, engine: "chromium", ttlSeconds: 300 });
    } else expect(url).toBe(collection + "/" + id);
    return {
      ok: true,
      json: async () =>
        init.method === "DELETE"
          ? { id, state: "closed" }
          : {
              id,
              engine: "chromium",
              key: init.method === "GET" ? "inspected-key" : "scoped-key",
              endpoint: `wss://gateway.test/v1/hosts/mac/browsers/${id}/connect`,
              expiresAt: new Date(Date.now() + 300000).toISOString(),
            },
    };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<BrowserLaunch host={host} />);
  fireEvent.click(screen.getByText("Launch Chromium"));
  await screen.findByText(/Connection interrupted/);
  fireEvent.click(screen.getByText("Retry launch"));
  await screen.findByText("scoped-key");
  fireEvent.click(screen.getByText("Inspect browser"));
  await screen.findByText("inspected-key");
  fireEvent.click(screen.getByText("Stop browser"));
  await screen.findByText("Browser stopped.");
  expect(screen.queryByText("inspected-key")).toBeNull();
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual([
    "POST",
    "POST",
    "GET",
    "DELETE",
  ]);
});
