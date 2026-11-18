import { webcrypto } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileInstall, mobileInstallEligible } from "./mobile-install";
import type { Machine } from "@/lib/inventory";

const machine = {
  id: "machine",
  hostId: "host",
  ownerId: "owner",
  observed: "running",
  desired: "running",
  ready: true,
  template: { os: "android", mode: "device" },
} as Machine;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
it("requires a running owned mobile device", () => {
  expect(mobileInstallEligible(machine, "owner")).toBe(true);
  expect(mobileInstallEligible(machine, "admin")).toBe(false);
  expect(
    mobileInstallEligible({ ...machine, powerOffRequest: "pending" }, "owner"),
  ).toBe(false);
  expect(
    mobileInstallEligible(
      { ...machine, template: { ...machine.template, os: "linux" } },
      "owner",
    ),
  ).toBe(false);
});
it("resumes a confirmed chunk and reuses the operation after a lost response", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let receipt: Record<string, unknown> = {};
  const ids: string[] = [];
  const artifacts: string[] = [];
  const chunks: number[] = [];
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    if (path === "/api/v1/machines/machine/app-artifacts") {
      artifacts.push(body.id);
      if (!receipt.id)
        receipt = {
          ...body,
          machineId: "machine",
          received: 0,
          chunkBytes: 524288,
          state: "uploading",
        };
    } else if (path.endsWith("/chunks")) {
      chunks.push(body.offset);
      receipt.received = 3;
      throw Error("lost");
    } else if (path.endsWith("/complete")) receipt.state = "ready";
    else if (path === "/api/v1/machines/machine/operations") {
      expect(body.arguments.artifact).toBe(receipt.id);
      ids.push(body.id);
      if (ids.length === 1) throw Error("lost");
      return Response.json({
        id: body.id,
        machineId: "machine",
        hostId: "host",
        state: "failed",
        result: { detail: "Package rejected" },
      });
    } else throw Error("Unexpected route");
    return Response.json(receipt);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MobileInstall machine={machine} />);
  fireEvent.change(screen.getByLabelText(/Android APK/), {
    target: { files: [new NodeFile(["apk"], "build.apk")] },
  });
  for (let i = 0; i < 3; i++) {
    fireEvent.click(screen.getByRole("button", { name: "Upload and install" }));
    await screen.findByRole("alert");
  }
  expect(screen.getByRole("alert").textContent).toBe("Package rejected");
  expect(chunks).toEqual([0]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(new Set(artifacts).size).toBe(1);
});
