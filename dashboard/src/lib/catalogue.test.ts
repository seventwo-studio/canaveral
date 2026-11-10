import { expect, test } from "vitest";
import {
  imageTask,
  imageTasks,
  importedImage,
  registryEntries,
  resources,
} from "./catalogue";

const amounts = { cpu: 2, memoryMiB: 4096, diskGiB: 32 };
const task = {
  id: "request",
  name: "Configured image",
  kind: "capture",
  state: "unknown",
  updatedAt: 1000,
  result: {
    detail: "Inspect before retrying",
    consistency: "crash-consistent",
  },
};
const entry = {
  id: "ubuntu",
  name: "Ubuntu",
  publisher: "Canonical",
  os: "linux",
  arch: "arm64",
  mediaType: "disk",
  format: "qcow2",
  sourcePage: "https://cloud-images.ubuntu.com/",
  resolver: "ubuntu-cloud",
  status: "available",
  minimum: amounts,
  note: "Installed disk",
};

test("image tasks preserve uncertain outcomes and bind acknowledgements to the caller's intent", () => {
  expect(imageTask(task, "request")).toEqual(task);
  expect(imageTasks({ tasks: [task] })).toEqual([task]);
  for (const value of [
    { ...task, id: "other" },
    { ...task, state: "complete" },
    { ...task, updatedAt: NaN },
    { ...task, result: { detail: {} } },
  ])
    expect(() => imageTask(value, "request")).toThrow();
});
test("image import confirmation requires matching task, byte count and SHA-256 identity", () => {
  const receipt = {
    id: "request",
    name: "Image",
    bytes: 2 ** 40,
    sha256: "a".repeat(64),
  };
  expect(importedImage(receipt, "request", 2 ** 40)).toEqual({
    name: "Image",
    sha256: receipt.sha256,
  });
  for (const value of [
    { ...receipt, id: "other" },
    { ...receipt, bytes: 0 },
    { ...receipt, sha256: "a".repeat(64) + "\n" },
  ])
    expect(() => importedImage(value, "request", 2 ** 40)).toThrow("Inspect");
});
test("registry decoder distinguishes installer media and manual sources without discarding requirements", () => {
  const manual = {
    ...entry,
    id: "windows",
    os: "windows",
    mediaType: "installer",
    format: "iso",
    resolver: null,
    status: "manual",
  };
  expect(registryEntries({ entries: [entry, manual] })).toEqual([
    entry,
    manual,
  ]);
  expect(() => registryEntries({ entries: [entry, entry] })).toThrow();
  expect(() =>
    registryEntries({
      entries: [{ ...entry, sourcePage: "javascript:alert(1)" }],
    }),
  ).toThrow();
  expect(() =>
    registryEntries({
      entries: [{ ...entry, minimum: { ...amounts, diskGiB: null } }],
    }),
  ).toThrow();
});
test("resource amounts never turn missing or invalid usage into zero", () => {
  expect(resources({ cpu: 0, memoryMiB: 0, diskGiB: 0 })).toEqual({
    cpu: 0,
    memoryMiB: 0,
    diskGiB: 0,
  });
  for (const value of [
    {},
    { ...amounts, cpu: -1 },
    { ...amounts, memoryMiB: Infinity },
    { ...amounts, diskGiB: "32" },
  ])
    expect(() => resources(value)).toThrow();
});
