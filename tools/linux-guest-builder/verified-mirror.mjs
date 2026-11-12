// Serve only the authenticated metadata and hash-checked archives to apt.
// No upstream metadata request is forwarded. Unknown paths fail closed.
import {createServer} from 'node:http';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [inputs, portFile] = process.argv.slice(2);
const prefix = '/dists/bookworm/';
const metadata = new Map([
  [prefix+'Release', readFileSync(inputs+'/Release')],
  [prefix+'Release.gpg', readFileSync(inputs+'/Release.gpg')],
  [prefix+'main/binary-arm64/Packages.xz', readFileSync(inputs+'/debian-Packages.xz')],
  [prefix+'main/binary-arm64/Packages', readFileSync(inputs+'/debian-Packages')],
]);
const packages = new Map();
for (const stanza of readFileSync(inputs+'/debian-Packages','utf8').split('\n\n')) {
  const path = stanza.match(/^Filename: (pool\/[A-Za-z0-9/_.+%~-]+)$/m)?.[1];
  const hash = stanza.match(/^SHA256: ([a-f0-9]{64})$/m)?.[1];
  if (path && hash) packages.set('/'+path, hash);
}
const server = createServer((req,res) => {
  let path;
  try { path = decodeURIComponent(req.url); } catch { res.writeHead(400); res.end(); return; }
  if (metadata.has(path)) {res.end(metadata.get(path)); return;}
  if (!packages.has(path)) {res.writeHead(404); res.end(); return;}
  const download = spawnSync('curl', ['-fLS','--retry','2','--max-time','600',
    'https://snapshot.debian.org/archive/debian/20261101T000000Z'+path], {maxBuffer:128*1024*1024});
  if (download.status !== 0 || createHash('sha256').update(download.stdout).digest('hex') !== packages.get(path)) {
    res.writeHead(502); res.end(); return;
  }
  res.end(download.stdout);
});
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
