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

it("retries a lost upload removal receipt without repeating the successful install", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let upload: Record<string, unknown> = {};
  let submits = 0,
    removals = 0;
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    if (path.endsWith("/app-artifacts")) {
      upload = {
        ...body,
        machineId: machine.id,
        chunkBytes: 524288,
        received: body.bytes,
        state: "ready",
      };
      return Response.json(upload);
    }
    if (path.endsWith("/operations")) {
      submits++;
      return Response.json({
        id: body.id,
        machineId: machine.id,
        hostId: machine.hostId,
        state: "succeeded",
        result: {
          installed: true,
          artifactCleaned: true,
          sha256: upload.sha256,
          bytes: upload.bytes,
        },
      });
    }
    if (path === "/api/v1/app-artifacts/" + upload.id + "/delete") {
      if (++removals === 1) throw Error("lost removal receipt");
      return Response.json({ ...upload, state: "deleted" });
    }
    throw Error("Unexpected route");
  });
  render(<MobileInstall machine={machine} />);
  fireEvent.change(screen.getByLabelText(/Android APK/), {
    target: { files: [new NodeFile(["apk"], "build.apk")] },
  });
  const install = screen.getByRole("button", { name: "Upload and install" });
  fireEvent.click(install);
  await screen.findByRole("alert");
  fireEvent.click(install);
  await screen.findByText(/^Installation succeeded · [a-f0-9-]{36}$/);
  expect(submits).toBe(1);
  expect(removals).toBe(2);
  expect(sessionStorage.length).toBe(0);
});
