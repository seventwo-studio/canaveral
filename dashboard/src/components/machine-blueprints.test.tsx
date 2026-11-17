import {
  cleanup,
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
