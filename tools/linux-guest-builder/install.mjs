// Install a new bundle directory on macOS; never replace an existing release.
import fs from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [sourceArg, targetArg = join(homedir(), '.canaveral-native/artifacts/bundle')] = process.argv.slice(2);
if (process.platform !== 'darwin' || !sourceArg) throw Error('usage: node install.mjs BUNDLE [NEW_DESTINATION] (macOS)');
const source = resolve(sourceArg), target = targetArg;
function ancestry(path) {
  if (!isAbsolute(path) || /\s/.test(path) || path.split('/').slice(1).some(c => !c || c === '.' || c === '..')) throw Error('canonical absolute path without spaces required');
  let part = '/';
  for (const component of path.split('/').slice(1)) {
    part = join(part, component);
    const s = fs.lstatSync(part);
    if (!s.isDirectory() || ![0, process.getuid()].includes(s.uid) || ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000)))) throw Error(`unsafe ancestor: ${part}`);
  }
}
ancestry(source); ancestry(dirname(target));
fs.mkdirSync(target, {mode: 0o700});
for (const name of ['Image', 'rootfs.erofs', 'initrd.cpio', 'manifest.json', 'image.digest', 'recipe.json']) {
  const from = join(source, name), to = join(target, name), s = fs.lstatSync(from);
  if (!s.isFile() || s.nlink !== 1 || ![0, process.getuid()].includes(s.uid)) throw Error('unsafe input');
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o400);
  const fd = fs.openSync(to, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
  execFileSync('/usr/bin/chflags', ['uchg', to]);
  const installed = fs.lstatSync(to);
  const flags = Number(execFileSync('/usr/bin/stat', ['-f', '%f', to], {encoding:'utf8'}).trim());
  if (installed.uid !== process.getuid() || installed.nlink !== 1 || (installed.mode & 0o7777) !== 0o400 || !(flags & 2)) throw Error('installation metadata mismatch');
}
const outputs = [];
for (const name of fs.readdirSync(target).sort()) {
  const path = join(target, name), hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  outputs.push({path, size: fs.statSync(path).size, sha256: hash.digest('hex')});
}
console.log(JSON.stringify({version:1, experimental:true, productionBuildReady:false, nativeBootAccepted:false, outputs}, null, 2));
