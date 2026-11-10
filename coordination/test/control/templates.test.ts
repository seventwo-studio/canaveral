import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enabledRuntimes, legacyDigest, legacyJson, loadHostConfig, normalizeTemplate, recipe, runtimeFor, source } from "../../src/control/templates.ts";
const minimum = { cpu: 2, memoryMiB: 2048, diskGiB: 10 };
const image = () => ({ id: "development", revision: "1", os: "linux", arch: "arm64", mode: "headless", minimum, prepare: { driver: "cloud-init", commands: ["touch /ready"] } });
test("public recipe contract strips private bindings, pins content and round trips", () => {
  const v = { ...image(), ssh: { identityFile: "/private/key" }, source: { path: "/first/base.raw", sha256: "a".repeat(64), format: "raw" } };
  const publicImage = normalizeTemplate(v);
  assert.equal(publicImage.preparationDriver, "cloud-init");
  assert.equal("prepare" in publicImage, false); assert.equal("ssh" in publicImage, false); assert.equal("source" in publicImage, false);
  assert.deepEqual(normalizeTemplate(publicImage), publicImage);
  assert.equal(normalizeTemplate({ ...v, source: { ...v.source, path: "/other/base.raw" } }).recipeDigest, publicImage.recipeDigest);
  assert.notEqual(normalizeTemplate({ ...v, prepare: { driver: "cloud-init", commands: ["touch /different"] } }).recipeDigest, publicImage.recipeDigest);
});
test("legacy digest retains sorted keys, separators and ASCII escaping", () => {
  assert.equal(legacyJson({ z: "🐈é", a: [1, true, null] }), '{"a": [1, true, null], "z": "\\ud83d\\udc08\\u00e9"}');
  assert.equal(legacyDigest("a".repeat(43)), "ff2f4f2c2550bd504d9035cafc76c4cd0fa3a1557c36ad43b5ac46f4a568be00");
});
test("host references load relative files and cannot replace recipe contracts", t => {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-template-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "image.json"), JSON.stringify(image()));
  const config = { provider: "linux", runtimes: { libvirt: {} }, templates: [{ templateFile: "image.json", bindings: { image: "/base.qcow2" } }] };
  writeFileSync(join(dir, "host.json"), JSON.stringify(config));
  const loaded = loadHostConfig(join(dir, "host.json")); assert.equal(loaded.templates[0]!.image, "/base.qcow2");
  assert.deepEqual(loaded.templates[0]!.prepare, image().prepare);
  writeFileSync(join(dir, "host.json"), JSON.stringify({ ...config, templates: [{ ...config.templates[0], bindings: { prepare: {} } }] }));
  assert.throws(() => loadHostConfig(join(dir, "host.json")));
});
test("preparation rejects invalid commands, absolute paths, packages, size and incompatible systems", () => {
  for (const v of [{ driver: "cloud-init", packages: ["-option"] }, { driver: "cloud-init", files: [{ path: "relative", content: "x" }] }, { driver: "cloudbase-init" }, { driver: "cloud-init", files: [{ path: "/file", content: "x", mode: "777" }] }, { driver: "cloud-init", timeoutSeconds: true }, { driver: "cloud-init", user: "-root" }, { driver: "cloud-init", sshAuthorizedKeys: ["ssh-ed25519 fixture"] }, { driver: "cloud-init", commands: [" "] }]) assert.throws(() => recipe(v, "linux"));
  assert.throws(() => normalizeTemplate({ ...image(), defaults: { ...minimum, memoryMiB: 512 } }));
  assert.throws(() => normalizeTemplate({ ...image(), memoryStepMiB: 300 }));
  assert.throws(() => source({ url: "http://private/base", sha256: "a".repeat(64), format: "raw" }));
  assert.throws(() => source({ url: "https://user:password@example.com/base", sha256: "a".repeat(64), format: "raw" }));
});
test("runtime catalogue and device definitions enforce operating system and architecture", () => {
  const config = { provider: "macos", runtimes: ["apple", "android"] };
  assert.deepEqual(Object.keys(enabledRuntimes(config)), ["apple", "android"]);
  assert.equal(runtimeFor(config, { os: "linux" }), "apple");
  assert.equal(runtimeFor(config, { os: "android" }), "android");
  assert.throws(() => runtimeFor(config, { os: "windows" }));
  assert.throws(() => enabledRuntimes({ provider: "linux", runtimes: ["libvirt", "libvirt"] }));
  assert.throws(() => enabledRuntimes({ provider: "linux", runtimes: { apple: {} } }));
  const android = { id: "phone", revision: "1", os: "android", arch: "arm64", mode: "device", minimum, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_7" } };
  assert.equal(normalizeTemplate(android).mode, "device");
  assert.throws(() => normalizeTemplate({ ...android, arch: "amd64" }));
  assert.throws(() => normalizeTemplate({ ...android, prepare: { driver: "ssh" } }));
});
test("explicit nulls and trailing newlines cannot bypass template validation", () => {
  for (const change of [{ defaults: null }, { memoryStepMiB: null }, { prepare: { driver: "cloud-init", packages: null } }, { prepare: { driver: "cloud-init", timeoutSeconds: null } }, { prepare: { driver: "cloud-init", files: null } }, { prepare: { driver: "cloud-init", packages: ["curl\n"] } }, { prepare: { driver: "cloud-init", files: [{ path: "/file", content: "x", mode: "0600\n" }] } }]) assert.throws(() => normalizeTemplate({ ...image(), ...change }));
  assert.throws(() => source({ path: "/base.raw", format: "raw", sha256: "a".repeat(64) + "\n" }));
});
