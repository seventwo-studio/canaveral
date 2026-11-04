import { expect, test } from "vitest";
import {
  accessibilitySnapshot,
  displayMessage,
  fileListing,
  shellStatus,
  uploadReceipt,
} from "./workspace";

const snapshot = () => ({
  snapshotId: "11111111-2222-4333-8444-555555555555",
  capturedAt: 1000,
  source: "windows-uia",
  coordinateSpace: "screen-pixels",
  truncated: false,
  coverage: "Fixture native hierarchy",
  nodes: [
    {
      id: "root",
      parentId: null,
      depth: 0,
      role: "window",
      name: "Editor",
      identifier: "editor",
      states: { enabled: true },
      actions: ["focus"],
      bounds: { x: -10, y: 2, width: 100, height: 80 },
      properties: { AutomationId: "editor", framework: "fixture" },
    },
  ],
});

test("normalized hierarchy decoding preserves agent metadata, states and negative screen origins", () => {
  const value = snapshot();
  expect(accessibilitySnapshot(value)).toEqual(value);
  const child = {
    ...value.nodes[0]!,
    id: "save",
    parentId: "root",
    depth: 1,
    identifier: "save-button",
    name: "Save",
  };
  expect(
    accessibilitySnapshot({ ...value, nodes: [...value.nodes, child] }).nodes[1]
      ?.properties.AutomationId,
  ).toBe("editor");
});

test("ambiguous or malformed hierarchy targets are rejected before they can be selected", () => {
  const value = snapshot(),
    node = value.nodes[0]!;
  for (const nodes of [
    [node, node],
    [{ ...node, parentId: "missing", depth: 1 }],
    [{ ...node, depth: 2 }],
    [{ ...node, bounds: { ...node.bounds, width: -1 } }],
    [{ ...node, actions: [true] }],
  ]) {
    expect(() => accessibilitySnapshot({ ...value, nodes })).toThrow();
  }
  expect(() => accessibilitySnapshot({ ...value, frame: {} })).toThrow();
  expect(() =>
    accessibilitySnapshot({ ...value, snapshotId: "unscoped" }),
  ).toThrow();
});

test("control messages grant ownership only for a recognized owned state", () => {
  expect(displayMessage('{"type":"control","state":"owned"}')).toEqual({
    type: "control",
    state: "owned",
  });
  expect(displayMessage('{"type":"control","state":"not-ready"}')).toEqual({
    type: "control",
    state: "not-ready",
  });
  expect(() => displayMessage('{"type":"control","state":true}')).toThrow();
  expect(() =>
    displayMessage(
      '{"type":"action-result","id":"request","state":"succeeded"}',
    ),
  ).toThrow();
  expect(() =>
    displayMessage(
      JSON.stringify({
        type: "control",
        state: "owned",
        text: "x".repeat(16384),
      }),
    ),
  ).toThrow();
});

test("terminal statuses preserve process exit and truncated output without accepting malformed events", () => {
  expect(shellStatus('{"exited":true,"exitCode":-9}')).toEqual({
    exited: true,
    exitCode: -9,
  });
  expect(shellStatus('{"truncated":true}')).toEqual({ truncated: true });
  expect(() => shellStatus('{"exited":"yes"}')).toThrow();
  expect(() => shellStatus("not-json")).toThrow();
});

test("file listings retain missing metadata and reparse entries while upload acknowledgement requires durability", () => {
  expect(
    fileListing({
      entries: [
        { name: "data", kind: "file" },
        { name: "link", kind: "symlink", size: null },
      ],
    }).entries,
  ).toHaveLength(2);
  expect(() =>
    fileListing({ entries: [{ name: "data", kind: "file", size: -1 }] }),
  ).toThrow();
  for (const receipt of [
    { uploaded: 10 },
    { uploaded: 10, durable: false },
    { uploaded: 9, durable: true },
  ]) {
    expect(() => uploadReceipt(receipt, 10)).toThrow("Inspect the destination");
  }
  // Metadata range, not a memory allocation or evidence of a native large upload.
  expect(
    uploadReceipt({ uploaded: 2 ** 40, durable: true }, 2 ** 40).uploaded,
  ).toBe(2 ** 40);
});
