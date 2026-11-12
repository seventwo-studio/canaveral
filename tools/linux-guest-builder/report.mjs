import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const roots = process.argv.slice(2).map(p => resolve(p));
async function walk(path) {
  const s = fs.lstatSync(path);
  if (s.isDirectory()) { for (const name of fs.readdirSync(path).sort()) await walk(join(path,name)); return; }
  if (!s.isFile() || s.nlink !== 1) throw Error(`unsafe report input ${path}`);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  files.push({path,size:s.size,sha256:hash.digest('hex'),mode:(s.mode&0o7777).toString(8)});
}
const files=[];
for (const root of roots) await walk(root);
console.log(JSON.stringify({version:1,experimental:true,productionBuildReady:false,cryptographicSignaturesVerified:false,nativeBootAccepted:false,signatureScope:'Individual upstream verification is recorded in signature logs; production trust approval and independent signature gates remain false.',files},null,2));
