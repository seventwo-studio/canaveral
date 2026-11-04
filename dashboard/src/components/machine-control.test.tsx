import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MachineControl } from "./machine-control";
import { operate } from "@/lib/machine-operations";
import type { WorkspaceMachine } from "@/lib/workspace";

vi.mock("@/lib/machine-operations", () => ({
  operate: vi.fn(async (_machine: string, action: string) =>
    action === "list-files" ? { path: "/", entries: [] } : {},
  ),
}));
vi.mock("./machine-terminal", () => ({
  MachineTerminal: () => <div aria-label="Fixture terminal" />,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const machine = (): WorkspaceMachine => ({
  id: "headless",
  name: "Headless Linux",
  observed: "running",
  ready: true,
  template: { os: "linux", arch: "arm64", mode: "headless", guestAccess: true },
  capabilities: {
    desktopStream: false,
    files: true,
    shell: true,
    accessibility: false,
  },
});

test("headless workspace exposes files and more than eight shells without mounting graphics", async () => {
  render(<MachineControl machine={machine()} onClose={() => {}} />);
  expect(screen.queryByRole("button", { name: "Desktop" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Inspect" })).toBeNull();
  await waitFor(() =>
    expect(operate).toHaveBeenCalledWith("headless", "list-files", {
      path: "/",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Terminals" }));
  for (let index = 0; index < 9; index++) {
    fireEvent.click(screen.getAllByRole("button", { name: "New shell" })[0]!);
    await screen.findByRole("button", { name: "Shell " + (index + 1) });
  }
  expect(
    vi
      .mocked(operate)
      .mock.calls.filter(([, action]) => action === "shell-open"),
  ).toHaveLength(9);
});

test("iOS never exposes a shell even if a malformed capability report claims one", () => {
  const ios = machine();
  ios.template = { os: "ios", arch: "arm64", mode: "device" };
  render(<MachineControl machine={ios} onClose={() => {}} />);
  expect(screen.queryByRole("button", { name: "Terminals" })).toBeNull();
  expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
  expect(
    vi.mocked(operate).mock.calls.some(([, action]) => action === "shell-open"),
  ).toBe(false);
});

test("capability changes select a supported view instead of retaining a hidden file screen", async () => {
  const initial = machine();
  initial.capabilities!.shell = false;
  const rendered = render(
    <MachineControl machine={initial} onClose={() => {}} />,
  );
  await screen.findByRole("button", { name: "Files" });
  rendered.rerender(
    <MachineControl
      machine={{
        ...initial,
        capabilities: { desktopStream: false, files: false, shell: true },
      }}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
  expect(
    await screen.findByText(
      "Independent shell sessions with their own working directory, environment and running processes.",
    ),
  ).toBeTruthy();
});
