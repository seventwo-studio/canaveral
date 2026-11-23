import { afterEach, it, vi, expect } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { Maintenance } from "./maintenance";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const status = {
  id: "drain",
  hostId: "host",
  scope: "directHost",
  phase: "draining",
  owners: ["manual"],
  safeToPowerOff: true,
  readyToResume: true,
  lastRunnerConfirmedAt: 123,
  blockers: [],
};
it("retries an interrupted begin with the same intent", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(null))
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(Response.json(status));
  vi.stubGlobal("fetch", fetch);
  render(<Maintenance host="host" />);
  await screen.findByText("No maintenance history.");
  fireEvent.click(screen.getByRole("button", { name: "Begin maintenance" }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Reason (optional)"), {
    target: { value: "service" },
  });
  const confirm = dialog.getByRole("button", { name: "Begin maintenance" });
  fireEvent.click(confirm);
  await dialog.findByRole("alert");
  fireEvent.click(confirm);
  await screen.findByText(/Safe to power off/);
  expect(fetch.mock.calls[1]![1].body).toBe(fetch.mock.calls[2]![1].body);
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toMatchObject({
    reason: "service",
    id: expect.any(String),
  });
});
it("renders the returned resume refusal and disables resume", async () => {
  const blocked = {
    ...status,
    readyToResume: false,
    safeToPowerOff: false,
    blockers: [
      {
        kind: "missingResource",
        id: "vm",
        detail: "Storage missing",
        state: "absent",
        blocks: ["resume", "powerOff"],
      },
    ],
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(
      Response.json(
        { code: "maintenance_blocked", status: blocked },
        { status: 409 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  render(<Maintenance host="host" />);
  await screen.findByText(/Safe to power off/);
  const button = screen.getByRole("button", { name: "Resume admission" });
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "maintenance_blocked",
    ),
  );
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/Storage missing/).textContent).toContain(
    "power off and resume",
  );
  expect(fetch.mock.calls[1]![0]).toBe(
    "/api/v1/hosts/host/maintenance/drain/resume",
  );
});
