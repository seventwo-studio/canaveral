import {
  cleanup,
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  BlueprintEditor,
  ImageLibrary,
  MachineBlueprints,
} from "./machine-blueprints";
import { blueprint, libraryImages } from "@/lib/blueprints";
import type { GroupedImage } from "@/lib/inventory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const source: GroupedImage = {
  id: "captured",
  name: "Prepared Linux",
  revision: "1",
  os: "linux",
  arch: "amd64",
  mode: "headless",
  imageKind: "derived",
  minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 },
  defaults: { cpu: 2, memoryMiB: 2048, diskGiB: 16 },
  hostId: "host",
  online: true,
  accepting: true,
  hosts: [{ id: "host", online: true, accepting: true }],
};
const saved = {
  id: "blueprint",
  name: "Development",
  revision: "1",
  source: { id: source.id, revision: source.revision, arch: source.arch },
  image: source,
  minimum: source.minimum,
  defaults: source.defaults!,
};

test("blueprint save rejects a mismatched receipt and retries the same immutable identity", async () => {
  const specs: (typeof saved)[] = [],
    onSaved = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const spec = JSON.parse(String(init.body));
      specs.push(spec);
      return {
        ok: true,
        json: async () => ({
          ...spec,
          image: source,
          id: specs.length === 1 ? "wrong" : spec.id,
        }),
      };
    }),
  );
  render(
    <BlueprintEditor
      sources={[source]}
      previous={null}
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.change(screen.getByLabelText("Blueprint name"), {
    target: { value: "Development" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save blueprint" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "outcome may be unknown",
  );
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save blueprint" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(specs).toHaveLength(2);
  expect(specs[1]).toEqual(specs[0]);
  expect(specs[0]!.defaults).toEqual(source.defaults);
});

test("a saved blueprint retains prepared-state identity and loses availability when its exact source disappears", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ blueprints: [saved] }),
    })),
  );
  const create = vi.fn();
  const view = render(
    <MachineBlueprints sources={[source]} admin={false} onCreate={create} />,
  );
  const button = await screen.findByRole("button", { name: "Create machine" });
  fireEvent.click(button);
  expect(create.mock.calls[0]![0]).toMatchObject({
    blueprintId: saved.id,
    blueprintRevision: saved.revision,
    defaults: saved.defaults,
  });
  expect(screen.getByText(/Prepared snapshot:/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New blueprint" })).toBeNull();
  view.rerender(
    <MachineBlueprints
      sources={[{ ...source, revision: "2" }]}
      admin={false}
      onCreate={create}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Create machine",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("library displays publisher evidence and keeps downloaded images visible without an online offer", async () => {
  const image = {
    id: "original",
    name: "Ubuntu original",
    hostId: "offline-host",
    kind: "base",
    os: "linux",
    arch: "amd64",
    format: "raw",
    mediaType: "disk",
    sha256: "a".repeat(64),
    bytes: 512,
    registry: {
      id: "ubuntu",
      version: "pinned-version",
      url: "https://cloud-images.ubuntu.com/image.img",
      publisherSha256: "a".repeat(64),
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ images: [image] }) })),
  );
  render(<ImageLibrary sources={[]} admin onBlueprint={() => {}} />);
  expect(await screen.findByText("Ubuntu original")).toBeTruthy();
  expect(screen.getByText("Publisher SHA-256 matched")).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Create blueprint",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(() =>
    libraryImages({ images: [{ ...image, kind: "derived" }] }),
  ).toThrow();
  expect(() =>
    libraryImages({
      images: [
        {
          ...image,
          registry: { ...image.registry, publisherSha256: "b".repeat(64) },
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    blueprint({ ...saved, source: { ...saved.source, revision: "wrong" } }),
  ).toThrow();
});

test("inventory reordering or withdrawal cannot retarget a blueprint editor's selected source", () => {
  const other = { ...source, id: "other", name: "Other source" };
  const props = { previous: null, onClose: () => {}, onSaved: () => {} };
  const view = render(
    <BlueprintEditor
      {...props}
      sources={[source, other]}
      initialSource={source}
    />,
  );
  const select = screen.getByLabelText(
    "Source image or prepared snapshot",
  ) as HTMLSelectElement;
  const selected = select.value;
  view.rerender(
    <BlueprintEditor
      {...props}
      sources={[other, source]}
      initialSource={source}
    />,
  );
  expect(select.value).toBe(selected);
  expect(select.selectedOptions[0]!.textContent).toContain("Prepared Linux");
  view.rerender(
    <BlueprintEditor {...props} sources={[other]} initialSource={source} />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Save blueprint",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

const originalImage = {
  id: "original",
  name: "Ubuntu original",
  hostId: "host",
  kind: "base",
  os: "linux",
  arch: "amd64",
  format: "raw",
  mediaType: "disk",
  sha256: "a".repeat(64),
  bytes: 2147483648,
};

for (const catalogue of ["images", "blueprints"] as const) {
  const label = catalogue === "images" ? "image library" : "machine blueprints";
  const title = catalogue === "images" ? "Ubuntu original" : "Development";
  const response =
    catalogue === "images"
      ? { images: [originalImage] }
      : { blueprints: [saved] };
  const empty = catalogue === "images" ? { images: [] } : { blueprints: [] };
  const renderCatalogue = () =>
    catalogue === "images"
      ? render(
          <ImageLibrary
            sources={[{ ...source, id: "original" }]}
            admin
            onBlueprint={vi.fn()}
          />,
        )
      : render(
          <MachineBlueprints sources={[source]} admin onCreate={vi.fn()} />,
        );

  test(`${catalogue} distinguishes a search miss from an empty catalogue and clears it`, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => response })),
    );
    renderCatalogue();
    await screen.findByText(title);
    fireEvent.change(screen.getByLabelText(`Search ${label}`), {
      target: { value: "not-a-real-os" },
    });
    expect(
      screen.getByText(
        catalogue === "images"
          ? "No matching images"
          : "No matching blueprints",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        catalogue === "images"
          ? "No downloaded images"
          : "No machine blueprints",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText(title)).toBeTruthy();
  });

  test(`${catalogue} keeps initial failure unavailable and retries into a verified empty catalogue`, async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (fail) throw new Error("Disconnected");
        return { ok: true, json: async () => empty };
      }),
    );
    renderCatalogue();
    await screen.findByText(
      catalogue === "images"
        ? "Image library unavailable"
        : "Blueprints unavailable",
    );
    expect(
      screen.queryByText(
        catalogue === "images"
          ? "No downloaded images"
          : "No machine blueprints",
      ),
    ).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be loaded",
    );
    fail = false;
    fireEvent.click(
      screen.getByRole("button", {
        name:
          catalogue === "images" ? "Retry image library" : "Retry blueprints",
      }),
    );
    await screen.findByText(
      catalogue === "images" ? "No downloaded images" : "No machine blueprints",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test(`${catalogue} retains and labels stale data while disabling creation until refresh succeeds`, async () => {
    let fail = false;
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error("Disconnected");
      return { ok: true, json: async () => response };
    });
    vi.stubGlobal("fetch", fetcher);
    renderCatalogue();
    const actionName =
      catalogue === "images" ? "Create blueprint" : "Create machine";
    await screen.findByText(title);
    expect(
      (screen.getByRole("button", { name: actionName }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: /^Refresh / }));
    await screen.findByRole("alert");
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Showing the last snapshot",
    );
    expect(
      (screen.getByRole("button", { name: actionName }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /^Refresh / }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      (screen.getByRole("button", { name: actionName }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
}

test("library keeps verification upfront and full immutable identity in an expandable disclosure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ images: [originalImage] }),
    })),
  );
  render(<ImageLibrary sources={[]} admin={false} onBlueprint={vi.fn()} />);
  await screen.findByText(originalImage.name);
  expect(
    screen.getByText("Manual import · publisher provenance unverified"),
  ).toBeTruthy();
  expect(screen.getByText("2 GiB")).toBeTruthy();
  const digest = screen.getByText(originalImage.sha256);
  expect(digest.closest("details")?.open).toBe(false);
  expect(screen.getByText("Source & checksum").tagName).toBe("SUMMARY");
});

test("library polling waits for a slow in-flight read instead of starving its response", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const response = {
    ok: true,
    json: async () => ({ images: [originalImage] }),
  };
  let complete!: (value: typeof response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<typeof response>((resolve) => {
          complete = resolve;
        }),
    )
    .mockImplementation(async () => response);
  vi.stubGlobal("fetch", fetcher);
  render(<ImageLibrary sources={[]} admin={false} onBlueprint={vi.fn()} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Loading image library…")).toBeTruthy();
  await act(async () => {
    complete(response);
  });
  expect(screen.getByText(originalImage.name)).toBeTruthy();
  const refresh = screen.getByRole("button", { name: /^Refresh / });
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  await act(async () => {
    fireEvent.click(refresh);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    (screen.getByRole("button", { name: /^Refresh / }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("blueprints with stale inventory do not advertise host availability or allow creation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ blueprints: [saved] }),
    })),
  );
  const create = vi.fn();
  const { rerender } = render(
    <MachineBlueprints
      sources={[source]}
      admin={false}
      onCreate={create}
      inventoryAvailable={false}
    />,
  );
  await screen.findByText("Development");
  expect(
    screen.getByText("Host availability unavailable", { selector: "span" }),
  ).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(
    "Refresh inventory from the workspace header",
  );
  expect(screen.queryByText("Available", { selector: "span" })).toBeNull();
  expect(
    screen.queryByText("No accepting host offers this source revision."),
  ).toBeNull();
  const action = screen.getByRole("button", {
    name: "Create machine",
  }) as HTMLButtonElement;
  expect(action.disabled).toBe(true);
  fireEvent.click(action);
  expect(create).not.toHaveBeenCalled();
  rerender(
    <MachineBlueprints
      sources={[source]}
      admin={false}
      onCreate={create}
      inventoryAvailable
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Create machine",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(screen.getByText("Available", { selector: "span" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create machine" }));
  expect(create).toHaveBeenCalledOnce();
});
