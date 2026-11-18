import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspacePreviews } from "./workspace-previews";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each(["static", "command"])(
  "retries an uncertain %s launch with identical files and UUID",
  async (mode) => {
    let row: Record<string, unknown> | undefined;
    const bodies: string[] = [];
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const reply = (value: unknown) => ({
          ok: true,
          json: async () => value,
        });
        if (url.endsWith("/open")) {
          expect(init.method).toBe("POST");
          return reply({ handoffUrl: "javascript:alert(1)" });
        }
        if (init.method === "POST") {
          bodies.push(String(init.body));
          if (bodies.length === 1) throw Error("Disconnected");
          const body = JSON.parse(bodies[1]!);
          row = {
            id: body.id,
            mode,
            state: "ready",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          };
          return reply(row);
        }
        if (url.endsWith("/previews"))
          return reply({ previews: row ? [row] : [] });
        expect(url).toBe("/api/v1/previews/" + row?.id);
        methods.push(init.method!);
        if (init.method === "DELETE") row = { ...row, state: "stopped" };
        return reply(row);
      }),
    );
    render(<WorkspacePreviews />);
    await screen.findByText("No previews yet.");
    if (mode === "command") {
      fireEvent.change(screen.getByLabelText("Preview type"), {
        target: { value: mode },
      });
      fireEvent.change(screen.getByLabelText(/Foreground command/), {
        target: { value: "node\napp with spaces.js" },
      });
    }
    const file = new File(["abc"], "index.html");
    Object.defineProperty(file, "webkitRelativePath", {
      value: "site/index.html",
    });
    fireEvent.change(screen.getByLabelText("Workspace directory"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByText("Launch preview"));
    await screen.findByText(/Connection interrupted/);
    fireEvent.click(screen.getByText("Retry same launch"));
    await screen.findByText("Open preview");
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!)).toEqual({
      id: expect.stringMatching(/^[a-f0-9-]{36}$/),
      mode,
      files: [{ path: "index.html", data: "YWJj" }],
      ...(mode === "command"
        ? { argv: ["node", "app with spaces.js"], port: 3000 }
        : {}),
    });
    fireEvent.click(screen.getByText("Open preview"));
    await screen.findByText("Invalid preview handoff.");
    fireEvent.click(screen.getByText("Inspect"));
    await waitFor(() => expect(methods).toEqual(["GET"]));
    await waitFor(() =>
      expect((screen.getByText("Release") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByText("Release"));
    await screen.findByText(/ · stopped/);
    expect(screen.queryByText("Open preview")).toBeNull();
  },
);
