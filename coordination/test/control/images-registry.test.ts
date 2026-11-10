import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowedUrl, catalogue, checksums, ImageLibrary, openSource, registryEntry, resolveRegistrySource, validateEntrySource } from "../../src/control/images.ts";
import type { ImageReader, RegistrySource, RegistryWorkerOptions } from "../../src/control/images.ts";

const payload = Buffer.alloc(512); payload.set([81, 70, 73, 251, 0, 0, 0, 3]);
const digest = createHash("sha256").update(payload).digest("hex");
const metadata = (id = randomUUID()) => ({ id, name: "Ubuntu disk", os: "linux", arch: "amd64", mode: "desktop", mediaType: "disk", format: "qcow2", minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 32 } });
const pinned: RegistrySource = { url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img", sha256: digest, bytes: payload.length, version: "fixture-build" };
function read(data: Uint8Array): ImageReader { let position = 0; return { read(count) { const chunk = data.subarray(position, position + count); position += chunk.length; return chunk; } }; }
function fixture(t: test.TestContext, source: RegistrySource = pinned) {
  const root = mkdtempSync(join(tmpdir(), "images-registry-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = new ImageLibrary(root), spec = metadata(), job = { id: spec.id, kind: "registry", registryId: "ubuntu-noble-cloud-amd64", metadata: spec }; let opens = 0, pins = 0;
  const options: RegistryWorkerOptions = { authorized: () => true, importSettings: () => ({}), resolveSource: async () => source,
    pinSource: async (id, value) => { assert.equal(id, job.id); pins++; return { ...job, source: value, bytes: value.bytes }; },
    openSource: async () => { assert.equal(pins, 1); opens++; return read(payload); } };
  return { root, library, job, options, opens: () => opens, pins: () => pins };
}

test("registry catalogue distinguishes manual media and source validation rejects unrelated origins", () => {
  const entries = catalogue(); assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
  assert.equal(registryEntry("windows-development-vm").status, "unavailable");
  assert.equal(registryEntry("windows-11-iso-arm64").resolver, null);
  for (const url of ["https://127.0.0.1/private", "http://cloud-images.ubuntu.com/disk", "https://user@cloud-images.ubuntu.com/disk", "https://cloud-images.ubuntu.com:8443/disk", "https://cloud-images.ubuntu.com/disk#fragment", "https://cloud-images.ubuntu.com.attacker.example/disk"]) assert.equal(allowedUrl(url), false);
  assert.equal(allowedUrl("https://chuangtzu.ftp.acc.umu.se/debian.iso"), true);
  const entry = registryEntry("ubuntu-noble-cloud-amd64");
  assert.throws(() => validateEntrySource(entry, { ...pinned, url: "https://cdn-apple.com/file" }));
  assert.throws(() => validateEntrySource(entry, { ...pinned, sha256: null }));
  assert.throws(() => validateEntrySource(entry, { ...pinned, bytes: true }));
  assert.throws(() => validateEntrySource(entry, { ...pinned, bytes: 2 ** 53 + 1 }));
  const apple = registryEntry("macos-supported");
  assert.equal(validateEntrySource(apple, { ...pinned, sha256: null, url: "https://updates.cdn-apple.com/restore.ipsw" }).sha256, null);
  assert.throws(() => validateEntrySource(apple, { ...pinned, sha256: null, url: "https://cdn-apple.com/restore.ipsw" }));
});

test("publisher manifests select newest numeric release and matching stable architecture", async () => {
  const manifest = `${"A".repeat(64)} *ubuntu-24.04.5-desktop-amd64.iso\n${"b".repeat(64)} *ubuntu-24.04.5.1-desktop-amd64.iso\n${"c".repeat(64)} *ubuntu-24.04.99-desktop-arm64.iso\n`;
  assert.equal(checksums(manifest)["ubuntu-24.04.5-desktop-amd64.iso"], "a".repeat(64));
  const source = await resolveRegistrySource(registryEntry("ubuntu-24.04-desktop-amd64"), { metadata: async () => manifest, length: async url => { assert.ok(url.endsWith("24.04.5.1-desktop-amd64.iso")); return 512; } });
  assert.equal(source.sha256, "b".repeat(64));
  await assert.rejects(resolveRegistrySource(registryEntry("ubuntu-26.04-desktop-arm64"), { metadata: async () => manifest, length: async () => 512 }), /no matching/);
  const releases = [
    { variant: "Workstation", arch: "aarch64", version: "44", link: "https://mirror.example/Fedora-44.iso", sha256: "a".repeat(64) },
    { variant: "Workstation", arch: "aarch64", version: "45_Beta", link: "https://mirror.example/Fedora-45.iso", sha256: "b".repeat(64) },
    { variant: "Workstation", arch: "aarch64", version: "99", link: "https://mirror.example/Fedora-99.raw.xz", sha256: "c".repeat(64) },
    { variant: "Workstation", arch: "x86_64", version: "46", link: "https://mirror.example/Fedora-46.iso", sha256: "d".repeat(64) },
  ];
  const fedora = await resolveRegistrySource(registryEntry("fedora-workstation-arm64"), { metadata: async () => JSON.stringify(releases), length: async () => 512 });
  assert.equal(fedora.version, "44"); assert.equal(new URL(fedora.url).hostname, "dl.fedoraproject.org");
  await assert.rejects(resolveRegistrySource(registryEntry("macos-supported")), /signed Apple/);
  await assert.rejects(resolveRegistrySource(registryEntry("windows-11-iso-amd64")), /file import/);
});

test("publisher redirects are checked before dispatch, including Debian's allowed redirect", async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }); });
  await assert.rejects(openSource("https://cdimage.debian.org/image.iso"), /outside/); assert.equal(calls.length, 1);
  calls.length = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://chuangtzu.ftp.acc.umu.se/image.iso" } }) : new Response("fixture");
  });
  assert.equal((await openSource("https://cdimage.debian.org/image.iso")).status, 200); assert.equal(calls.length, 2);
});

test("registry worker waits for exact reservation acknowledgement, verifies checksum and gates publication", async t => {
  const f = fixture(t), report = await f.library.registryImport(f.job, f.options);
  assert.equal(report.state, "succeeded"); assert.equal(f.opens(), 1); assert.equal(f.pins(), 1);
  assert.equal(report.result.sha256, digest); assert.equal((report.result.registry as Record<string, unknown>).publisherSha256, digest);
  assert.deepEqual(f.library.definitions(), []);
  f.library.acknowledge({ [f.job.id]: digest }); assert.equal(f.library.definitions().length, 1);
  assert.deepEqual(await f.library.registryImport(f.job, f.options), report); assert.equal(f.opens(), 1);
  const bad = fixture(t);
  bad.options.pinSource = async () => ({ ...bad.job, bytes: pinned.bytes, source: { ...pinned, version: "substituted" } });
  assert.equal((await bad.library.registryImport(bad.job, bad.options)).state, "failed"); assert.equal(bad.opens(), 0); assert.deepEqual(bad.library.records(), []);
});

test("checksum failures clean partials; interrupted started receipts remain unknown without replay", async t => {
  const wrong = fixture(t, { ...pinned, sha256: "b".repeat(64) });
  assert.equal((await wrong.library.registryImport(wrong.job, wrong.options)).state, "failed"); assert.deepEqual(wrong.library.records(), []);
  assert.deepEqual(readdirSync(wrong.library.root).filter(p => p.endsWith(".partial")), []);
  const f = fixture(t); f.options.openSource = async () => { throw new Error("Uncertain download state"); };
  const report = await f.library.registryImport(f.job, f.options);
  assert.equal(report.state, "unknown");
  f.options.openSource = async () => { throw new Error("Must not replay"); };
  assert.deepEqual(await f.library.registryImport(f.job, f.options), report);
});

test("registry reuses verified local content and recovery validates published identity and stored bytes", async t => {
  const f = fixture(t), firstMetadata = metadata();
  await f.library.importStream(firstMetadata, read(payload), payload.length, () => true);
  const report = await f.library.registryImport(f.job, f.options); assert.equal(report.state, "succeeded"); assert.equal(f.opens(), 0);
  const receipt = join(f.library.root, `${f.job.id}.registry.receipt`), started = JSON.parse(readFileSync(receipt, "utf8")); delete started.report; started.started = true;
  writeFileSync(receipt, JSON.stringify(started)); assert.deepEqual(await f.library.registryImport(f.job, f.options), report);
  const record = f.library.records().find(r => r.public.id === f.job.id)!;
  chmodSync(String(record.definition.image), 0o600); writeFileSync(String(record.definition.image), Buffer.alloc(512));
  await assert.rejects(f.library.registryImport(f.job, f.options), /pinned registry task/);
  assert.equal(f.opens(), 0);
});

test("loss of authorization after a read removes the partial download", async t => {
  const f = fixture(t); let authorized = true;
  f.options.authorized = () => authorized;
  f.options.openSource = async () => ({ read(count) { authorized = false; return payload.subarray(0, count); } });
  assert.equal((await f.library.registryImport(f.job, f.options)).state, "failed");
  assert.deepEqual(f.library.records(), []); assert.deepEqual(readdirSync(f.library.root).filter(p => p.endsWith(".partial")), []);
});
