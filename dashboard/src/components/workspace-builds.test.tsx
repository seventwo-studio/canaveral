import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceBuilds } from "./workspace-builds";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("recovers the same build and exposes its verified artifact after release", async () => {
  const bodies: string[] = [];
  let id = "";
  let state = "stopping";
  const row = () => ({
    id,
    state,
    imageId: "toolchain",
    artifact: "out/build",
    result: { stdoutBase64: "b2s=", stderrBase64: "", exitCode: 0 },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const reply = (value: unknown) => ({ ok: true, json: async () => value });
      if (url.endsWith("/images"))
        return reply({
          images: [
            {
              id: "toolchain",
              templateId: "linux",
              templateRevision: "1",
              arch: "arm64",
              digest: "sha256:" + "a".repeat(64),
            },
          ],
        });
      if (init.method === "POST") {
        bodies.push(String(init.body));
        id = JSON.parse(bodies[0]!).id;
        if (bodies.length === 1) throw Error("disconnected");
        return reply(row());
      }
      if (url.endsWith("/builds")) return reply({ builds: id ? [row()] : [] });
      expect(url).toBe("/api/v1/builds/" + id);
      return reply(row());
    }),
  );
  render(<WorkspaceBuilds />);
  await screen.findByText("No builds yet.");
  const file = new File(["input"], "source.txt");
  Object.defineProperty(file, "webkitRelativePath", {
    value: "project/src/source.txt",
  });
  fireEvent.change(screen.getByLabelText("Source directory"), {
    target: { files: [file] },
  });
  fireEvent.change(screen.getByLabelText(/Command/), {
    target: { value: "make\nargument with spaces" },
  });
  fireEvent.change(screen.getByLabelText("Artifact path"), {
    target: { value: "out/build" },
  });
  fireEvent.click(screen.getByText("Launch build"));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByText("Retry same launch"));
  await screen.findByText("ok");
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0]!)).toEqual({
    id,
    imageId: "toolchain",
    artifact: "out/build",
    argv: ["make", "argument with spaces"],
    files: [{ path: "src/source.txt", data: "aW5wdXQ=" }],
  });
  expect(screen.queryByRole("link")).toBeNull();
  state = "succeeded";
  fireEvent.click(screen.getByText("Refresh builds"));
  expect(
    (
      await screen.findByRole("link", { name: "Download verified artifact" })
    ).getAttribute("href"),
  ).toBe("/api/v1/builds/" + id + "/artifact");
});
