import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

test.each(["Chromium", "Firefox", "WebKit"])(
  "recovers an uncertain %s launch and manages it after drainage",
  async (label) => {
    const engine = label.toLowerCase();
    let id = "";
    const collection = "/api/v1/hosts/mac/browsers";
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        expect(url).toBe(collection);
        const body = JSON.parse(String(init.body));
        if (!id) {
          expect(body.id).toMatch(/^[a-f0-9-]{36}$/);
          id = body.id;
          expect(body).toEqual({ id, engine, ttlSeconds: 300 });
          throw new Error("Disconnected");
        }
        expect(body).toEqual({ id, engine, ttlSeconds: 300 });
      } else expect(url).toBe(collection + "/" + id);
      return {
        ok: true,
        json: async () =>
          init.method === "DELETE"
            ? { id, state: "closed" }
            : {
                id,
                engine,
                key: init.method === "GET" ? "inspected-key" : "scoped-key",
                endpoint: `wss://gateway.test/v1/hosts/mac/browsers/${id}/connect`,
                expiresAt: new Date(Date.now() + 300000).toISOString(),
              },
      };
    });
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<BrowserLaunch host={host} />);
    const select = screen.getByRole("combobox", {
      name: "Browser engine",
    }) as HTMLSelectElement;
    expect(select.value).toBe("chromium");
    fireEvent.change(select, { target: { value: engine } });
    fireEvent.click(screen.getByText(`Launch ${label}`));
    await screen.findByText(/Connection interrupted/);
    expect(select.disabled).toBe(true);
    rerender(<BrowserLaunch host={{ ...host, enabled: false }} />);
    expect(screen.queryByText("Retry launch")).toBeNull();
    rerender(<BrowserLaunch host={host} />);
    fireEvent.click(screen.getByText("Retry launch"));
    await screen.findByText("scoped-key");
    rerender(<BrowserLaunch host={{ ...host, enabled: false }} />);
    fireEvent.click(screen.getByText("Inspect browser"));
    await screen.findByText("inspected-key");
    fireEvent.click(screen.getByText("Stop browser"));
    await waitFor(() => expect(screen.queryByText("Stop browser")).toBeNull());
    expect(screen.queryByText("inspected-key")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "POST",
      "GET",
      "DELETE",
    ]);
  },
);

test("rejects a scoped receipt for a different engine", async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { id } = JSON.parse(String(init.body));
    return {
      ok: true,
      json: async () => ({
        id,
        engine: "chromium",
        key: "untrusted-key",
        endpoint: `wss://gateway.test/v1/hosts/mac/browsers/${id}/connect`,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
    };
  });
  render(<BrowserLaunch host={host} />);
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "webkit" },
  });
  fireEvent.click(screen.getByText("Launch WebKit"));
  await screen.findByText(/Connection interrupted/);
  expect(screen.queryByText("untrusted-key")).toBeNull();
  expect(screen.getByText("Stop browser")).toBeTruthy();
});
