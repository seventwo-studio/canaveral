import { record } from "./types";
import { resources } from "./catalogue";
import type { Resources } from "./catalogue";
import { imagesResponse } from "./inventory";
import type { GroupedImage, ImageOffer } from "./inventory";

export interface Blueprint {
  id: string;
  revision: string;
  name: string;
  source: { id: string; revision: string; arch: string };
  image: ImageOffer;
  minimum: Resources;
  defaults: Resources;
}
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
export function blueprint(value: unknown): Blueprint {
  const b = record(value),
    source = record(b.source),
    image = record(b.image);
  if (
    ![b.id, b.revision, b.name, source.id, source.revision, source.arch].every(
      text,
    ) ||
    source.id !== image.id ||
    source.revision !== image.revision ||
    source.arch !== image.arch
  )
    throw new Error("Invalid blueprint source or identity.");
  const parsed = imagesResponse({
    templates: [
      { ...image, hostId: "blueprint-source", online: false, accepting: false },
    ],
  })[0]!;
  const minimum = resources(b.minimum),
    defaults = resources(b.defaults);
  if (
    ["cpu", "memoryMiB", "diskGiB"].some(
      (k) =>
        minimum[k as keyof Resources] < parsed.minimum[k as keyof Resources] ||
        defaults[k as keyof Resources] < minimum[k as keyof Resources],
    ) ||
    parsed.mode === "device" ||
    minimum.memoryMiB % (parsed.memoryStepMiB || 1) ||
    defaults.memoryMiB % (parsed.memoryStepMiB || 1)
  )
    throw new Error("Invalid blueprint resources.");
  return { ...b, image: parsed, minimum, defaults } as unknown as Blueprint;
}
export function blueprints(value: unknown): Blueprint[] {
  const entries = record(value).blueprints;
  if (!Array.isArray(entries)) throw new Error("Invalid blueprint collection.");
  const seen = new Set<string>();
  return entries.map((value) => {
    const b = blueprint(value),
      key = JSON.stringify([b.id, b.revision]);
    if (seen.has(key)) throw new Error("Duplicate blueprint revision.");
    seen.add(key);
    return b;
  });
}
export function blueprintOffer(
  b: Blueprint,
  sources: GroupedImage[],
): GroupedImage {
  const source = sources.find(
    (s) =>
      s.id === b.source.id &&
      s.revision === b.source.revision &&
      s.arch === b.source.arch,
  );
  return {
    ...b.image,
    id: b.id,
    name: b.name,
    revision: b.revision,
    minimum: b.minimum,
    defaults: b.defaults,
    blueprintId: b.id,
    blueprintRevision: b.revision,
    hosts: source?.hosts ?? [],
  };
}
export interface LibraryImage {
  id: string;
  name: string;
  hostId: string;
  os: string;
  arch: string;
  format: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  registry?: {
    id: string;
    version: string;
    url: string;
    publisherSha256: string | null;
  };
}
export function libraryImages(value: unknown): LibraryImage[] {
  const items = record(value).images;
  if (!Array.isArray(items)) throw new Error("Invalid image library.");
  return items.map((value) => {
    const i = record(value);
    if (
      i.kind !== "base" ||
      ![i.id, i.name, i.hostId, i.os, i.arch, i.format].every(text) ||
      !["disk", "installer"].includes(String(i.mediaType)) ||
      typeof i.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(i.sha256) ||
      typeof i.bytes !== "number" ||
      !Number.isSafeInteger(i.bytes) ||
      i.bytes < 512
    )
      throw new Error("Invalid original image.");
    if (i.registry !== undefined) {
      const r = record(i.registry);
      if (
        ![r.id, r.version, r.url].every(text) ||
        new URL(String(r.url)).protocol !== "https:" ||
        (r.publisherSha256 !== null && r.publisherSha256 !== i.sha256)
      )
        throw new Error("Invalid image provenance.");
    }
    return i as unknown as LibraryImage;
  });
}
