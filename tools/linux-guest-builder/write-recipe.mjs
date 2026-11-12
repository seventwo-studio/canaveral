// Generate assembler recipe and exhaustive evidence from locally verified bytes.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const dir = resolve(process.argv[2]);
const files = [];
const hash = path => createHash('sha256').update(readFileSync(join(dir, path))).digest('hex');
function pin(role, identity, path) {
  files.push({ role, path, size: statSync(join(dir, path)).size });
  return { identity, sha256: hash(path) };
}
function artifact(path) { return { path, sha256: hash(path), size: statSync(join(dir, path)).size }; }
const packages = readFileSync(join(dir, 'packages.tsv'), 'utf8').trim().split('\n').sort().map((line, i) => {
  const [identity, path] = line.split('\t');
  return pin(`debian.packages[${i}]`, identity, path);
});
const probe = name => readFileSync(join(dir, `probe-${name}.txt`), 'utf8').trim().split('\n')[0].trim();
if (probe('shell') !== 'canaveral-shell-v1' || probe('node') !== 'v24.11.0' || !probe('git').startsWith('git version ')) throw Error('tool probes differ');
if (!probe('mkfsExt4').startsWith('mke2fs ')) throw Error('mkfs.ext4 probe differs');
const recipe = {
  version: 2, id: 'linux-native-experimental', revision: 1,
  commandLine: 'console=hvc0 root=/dev/vda rootfstype=erofs ro',
  toolVersions: { shell: probe('shell'), git: probe('git'), node: probe('node'), mkfsExt4: probe('mkfsExt4') },
  epoch: 1793491200, kernel: artifact('Image'), rootfs: artifact('rootfs.erofs'), bootstrap: artifact('bootstrap'),
  provenance: {
    debian: { snapshot: '20261101T000000Z',
      release: pin('debian.release', 'bookworm Release', 'Release'),
      signingKey: pin('debian.signingKey', 'debian-archive-keyring.gpg', 'debian-archive-keyring.gpg'),
      signature: pin('debian.signature', 'bookworm Release.gpg', 'Release.gpg'), packages },
    node: pin('node', 'node-v24.11.0-linux-arm64.tar.xz', 'node-v24.11.0-linux-arm64.tar.xz'),
    nodeSignature: pin('nodeSignature', 'Node v24.11.0 signed SHASUMS256', 'node-sums.asc'),
    nodeSigningKey: pin('nodeSigningKey', 'C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C experimental release keyring', 'node-keys.kbx'),
    rust: ['rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz', 'rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz'].map((p, i) => pin(`rust[${i}]`, p, p)),
    kernelSource: pin('kernelSource', 'linux-6.12.117.tar.xz', 'linux-6.12.117.tar.xz'),
    kernelConfig: pin('kernelConfig', 'Linux 6.12.117 resolved arm64 built-in config', 'kernel.config'),
    kernelPatches: [],
    erofsTool: pin('erofsTool', 'erofs-utils 1.8.6-1 Debian arm64 mkfs.erofs', 'linux-mkfs.erofs'),
    bootstrapSource: pin('bootstrapSource', 'Canaveral source archive including Cargo.lock; see source-revision.txt', 'source.tar')
  }
};
writeFileSync(join(dir, 'recipe.json'), JSON.stringify(recipe, null, 2));
writeFileSync(join(dir, 'evidence.json'), JSON.stringify({version: 1, files}, null, 2));
