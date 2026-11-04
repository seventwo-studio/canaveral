import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ImageCapture } from "./image-actions";
import { SharedBudgets } from "./shared-budgets";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a mismatched budget receipt cannot confirm a save; an explicit retry keeps the original intent", async () => {
  const ids: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      let value: unknown = { budgets: [] };
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          id: string;
          name: string;
          capacity: { cpu: number; memoryMiB: number; diskGiB: number };
          hostIds: string[];
        };
        ids.push(body.id);
        value = {
          ...body,
          id: ids.length === 1 ? "wrong-budget" : body.id,
          reserved: { cpu: 0, memoryMiB: 0, diskGiB: 32 },
          overcommitted: false,
        };
      }
      return { ok: true, json: async () => value };
    }),
  );
  const refreshed = vi.fn();
  render(<SharedBudgets hosts={[]} onClose={() => {}} onRefresh={refreshed} />);
  fireEvent.change(screen.getByLabelText("Budget name"), {
    target: { value: "Shared host" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save shared budget" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(refreshed).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Shared host/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save shared budget" }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test("an uncertain capture remains a recovery outcome without offering another capture", async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: string; name: string };
    return {
      ok: true,
      json: async () => ({
        id: body.id,
        name: body.name,
        state: "unknown",
        kind: "capture",
        updatedAt: 1000,
        result: { detail: "Publication needs inspection." },
      }),
    };
  });
  vi.stubGlobal("fetch", fetcher);
  const refreshed = vi.fn();
  render(
    <ImageCapture
      machine={{
        id: "source",
        name: "Linux",
        desired: "stopped",
        observed: "stopped",
      }}
      onClose={() => {}}
      onRefresh={refreshed}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Capture image" }));
  expect(await screen.findByText("Capture needs recovery")).toBeTruthy();
  expect(screen.getByText("Publication needs inspection.")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(refreshed).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Capture image" })).toBeNull();
});
