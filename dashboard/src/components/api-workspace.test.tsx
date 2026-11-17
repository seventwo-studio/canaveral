import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiWorkspace } from "./api-workspace";
import { actionBody, actionPath, apiActions } from "@/lib/api-workspace";
import type { User } from "@/lib/inventory";
const admin: User = {
  id: "admin",
  username: "admin",
  role: "admin",
  status: "active",
};
let calls: { path: string; body: unknown }[];
let reply: (path: string) => Promise<unknown>;
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  calls = [];
  reply = async () => ({ applications: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      calls.push({
        path: url,
        body: options.body ? JSON.parse(String(options.body)) : undefined,
      });
      return { ok: true, json: async () => reply(url) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(label));
  await user.click(screen.getByRole("option", { name: option }));
}
it("exposes explicit administrator actions and rejects path injection", () => {
  expect(apiActions.length).toBeGreaterThan(35);
  expect(
    apiActions.every(
      (action) =>
        !action.path.includes("/poll") && !action.path.includes("/report"),
    ),
  ).toBe(true);
  const inspect = apiActions.find((action) => action.id === "domain-inspect")!;
  expect(() => actionPath(inspect, "../consumers")).toThrow("UUID");
  expect(() => actionBody("[]")).toThrow("JSON object");
  expect(() => actionBody("{")).toThrow("valid JSON");
});
it("requires confirmation and retains exact configuration and UUID across failed attempts", async () => {
  render(<ApiWorkspace user={admin} onDenied={vi.fn()} />);
  await choose("Feature", "Applications");
  await choose("Action", "Create application");
  const original = (
    screen.getByLabelText(
      "Advanced configuration (JSON)",
    ) as HTMLTextAreaElement
  ).value;
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review action" }));
  expect(calls).toHaveLength(0);
  reply = async () => {
    throw new Error("Lost reply");
  };
  await user.click(screen.getByRole("button", { name: "Apply action" }));
  await screen.findByRole("alert");
  expect(
    (
      screen.getByLabelText(
        "Advanced configuration (JSON)",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe(original);
  await user.click(screen.getByRole("button", { name: "Review action" }));
  await user.click(screen.getByRole("button", { name: "Apply action" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0]!.body).toEqual(calls[1]!.body);
});
it("discards credentials and late responses when the account changes", async () => {
  let resolve!: (value: unknown) => void;
  reply = () =>
    new Promise((done) => {
      resolve = done;
    });
  const { rerender } = render(<ApiWorkspace user={admin} onDenied={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  rerender(
    <ApiWorkspace user={{ ...admin, id: "other" }} onDenied={vi.fn()} />,
  );
  await act(async () => resolve({ credential: "old-account-secret" }));
  expect(screen.queryByText(/old-account-secret/)).toBeNull();
});
it("does not send requests for ordinary users and signals denied administrator access", async () => {
  const onDenied = vi.fn();
  const { rerender } = render(
    <ApiWorkspace user={{ ...admin, role: "user" }} onDenied={onDenied} />,
  );
  expect(screen.getByText("Administrator access required.")).toBeTruthy();
  expect(calls).toHaveLength(0);
  rerender(<ApiWorkspace user={admin} onDenied={onDenied} />);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    })),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(onDenied).toHaveBeenCalledOnce());
});
it("provides a bounded explicit path and JSON object example for every action", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const ids = new Set<string>();
  for (const action of apiActions) {
    expect(ids.has(action.id)).toBe(false);
    ids.add(action.id);
    const path = actionPath(
      action,
      action.identifier === "SHA-256" ? "a".repeat(64) : id,
      id,
    );
    expect(path).not.toContain("{");
    expect(path).not.toContain("?");
    expect(path).not.toContain("..");
    if (action.method === "POST") {
      expect(action.example).toBeTypeOf("function");
      const example = action.example!();
      expect(actionBody(JSON.stringify(example))).toEqual(example);
    } else expect(action.example).toBeUndefined();
  }
});
it("navigates configuration pages using only bounded explicit paths", async () => {
  reply = async (path) =>
    path.endsWith("/pages/1")
      ? { page: 1, nextPage: null, modelCatalog: [{ model: "second" }] }
      : { page: 0, nextPage: 1, modelCatalog: [{ model: "first" }] };
  render(<ApiWorkspace user={admin} onDenied={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Page 1");
  expect(
    (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("Page 2");
  expect(calls[1]!.path).toBe("/api/v1/admin/configuration/pages/1");
  expect(
    (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Previous page" }));
  await screen.findByText("Page 1");
  expect(calls[2]!.path).toBe("/api/v1/admin/configuration");
});
it("refuses a malformed next page rather than following an injected path", async () => {
  reply = async () => ({ page: 0, nextPage: "../consumers" });
  render(<ApiWorkspace user={admin} onDenied={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Page 1");
  expect(
    (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
