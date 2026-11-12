// Enumerate all executed source inputs, including locally maintained build code.
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {archiveEntries} from './archive-entries.mjs';
const [inputs, recipe] = process.argv.slice(2);
const digest=b=>createHash('sha256').update(b).digest('hex');
const revision=readFileSync(inputs+'/source-revision.txt','utf8').trim();
assert.match(revision,/^[0-9a-f]{40}$/);
const repository=execFileSync('git',['-C',recipe,'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
const source=execFileSync('git',['-C',repository,'archive',revision],{maxBuffer:128*1024*1024});
assert.deepEqual(archiveEntries(source),archiveEntries(readFileSync(inputs+'/source.tar')),'source archive differs from recorded Git revision');
const packageEvidence = JSON.parse(readFileSync(inputs+'/debian-packages-verified.json','utf8'));
assert(packageEvidence.formatterClosure?.some(p=>p.identity.startsWith('e2fsprogs=')), 'missing authenticated formatter closure');
const records = [
 ['linux-6.12.117.tar.xz','pinned kernel primary signature and SHA256'],
 ['node-v24.11.0-linux-arm64.tar.xz','pinned Node primary signature and SHA256'],
 ['rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz','pinned Rust primary signature and SHA256'],
 ['rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz','pinned Rust primary signature and SHA256'],
 ['erofs-utils-1.8.6.tar.gz','pinned Debian primary Release signature -> Sources -> dsc -> SHA256'],
 ['source.tar','exact git archive of operator-selected revision '+revision],
 ['debian-packages-verified.json','pinned Debian snapshot Release -> Packages -> every retained package'],
];
const lock=execFileSync('git',['-C',recipe,'show',revision+':Cargo.lock']);
assert(lock.includes('checksum = '),'Cargo registry authentication missing');
records.push(['source-revision.txt','Cargo.lock registry checksums enforced by cargo --locked; local crates from authenticated source archive']);
writeFileSync(inputs+'/authenticated-inputs.json',JSON.stringify({
 inputs:records.map(([file,authentication])=>({file,authentication,sha256:digest(readFileSync(inputs+'/'+file))})),
 operatorPrerequisites:'Checksum-pinned Lima image and its apt chain supply compiler, libc, shell, make, mmdebstrap, erofs-utils, Git, Node and signature tools. Host Xcode/autotools and this reviewed recipe checkout are operator prerequisites, not downloaded build inputs.',
 recipeInputs:readdirSync(recipe).filter(n=>/\.(sh|mjs|config|yaml)$/.test(n)&&!n.endsWith('.test.mjs')).sort().map(file=>({file,authentication:'operator-reviewed recipe checkout',sha256:digest(readFileSync(recipe+'/'+file))})),
 recipeDiffSha256:digest(execFileSync('git',['-C',recipe,'diff','HEAD','--','.'])),
 recipeRevision:execFileSync('git',['-C',recipe,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
},null,2));
