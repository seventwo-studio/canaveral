import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ImageCapture } from "./image-actions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
