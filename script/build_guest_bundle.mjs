#!/usr/bin/env node
/** Deterministic guest seed artifacts. Uses supplied Linux ELF helpers; never builds, installs or executes them. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = join(ROOT, 'coordination/src');
const require = createRequire(join(ROOT, 'coordination/package.json'));
const ts = require('typescript');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function elf(file, arch) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 64 || metadata.size > 64 * 1048576) throw new Error('Supply a bounded regular prebuilt Linux ELF helper.');
  const bytes = readFileSync(file);
  if (!bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)) throw new Error('Guest helper ELF architecture differs from the bundle.');
  return bytes;
}
export function buildGuestBundle({ nativeHelper, atspiHelper, arch }) {
  if (!['arm64', 'amd64'].includes(arch)) throw new Error('Choose --arch arm64 or amd64.');
  const artifacts = new Map(), visited = new Set();
  const put = (path, content, mode = '0644') => { if (artifacts.has(path)) throw new Error('Duplicate bundle artifact.'); artifacts.set(path, { path, content, mode }); };
  function module(source) {
    source = resolve(source);
    if (!source.startsWith(SOURCE + '/') || !source.endsWith('.ts')) throw new Error('Guest module dependency escaped the source tree.');
    if (visited.has(source)) return; visited.add(source);
    const result = ts.transpileModule(readFileSync(source, 'utf8'), { fileName: source, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, removeComments: true, verbatimModuleSyntax: true } });
    if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('Guest module transpilation failed.');
    const dependencies = new Set();
    const output = result.outputText.replace(/\b(from\s*|import\s*\(|import\s*)(["'])(\.[^"']+)(["'])/g, (full, prefix, quote, specifier, end) => {
      if (quote !== end || !/\.(?:ts|js)$/.test(specifier)) throw new Error('Unsupported guest module dependency.');
      dependencies.add(resolve(dirname(source), specifier.replace(/\.js$/, '.ts')));
      return prefix + quote + specifier.replace(/\.(?:ts|js)$/, '.mjs') + end;
    });
    put('/opt/canaveral/modules/' + relative(SOURCE, source).replaceAll('\\', '/').replace(/\.ts$/, '.mjs'), output);
    [...dependencies].sort().forEach(module);
  }
  module(join(SOURCE, 'guest/linux-services.ts'));
  put('/opt/canaveral/server.mjs', "import { startLinuxGuest } from './modules/guest/linux-services.mjs';\nawait startLinuxGuest();\n");
  const helpers = [];
  for (const [name, file] of [['canaveral-mobile-native', nativeHelper], ['canaveral-guest-agent', atspiHelper]]) {
    if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Supply absolute --native-helper and --atspi-helper paths.');
    const bytes = elf(file, arch), encoded = bytes.toString('base64'), parts = [];
    for (let offset = 0; offset < encoded.length; offset += 49152) {
      const part = `/opt/canaveral/payload/${name}.${String(parts.length).padStart(4, '0')}.b64`;
      put(part, encoded.slice(offset, offset + 49152)); parts.push(part);
    }
    helpers.push({ name, sha256: sha(bytes), bytes: bytes.length, parts });
  }
  put('/opt/canaveral/install.mjs', `import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
if(process.platform!=='linux'||process.arch!==${JSON.stringify(arch === 'amd64' ? 'x64' : 'arm64')}||Number(process.versions.node.split('.')[0])<24) throw new Error('Guest bundle requires matching Linux architecture and Node 24+.');
const helpers=${JSON.stringify(helpers)};
function noLinks(path){ for(let p=path;;p=dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink())throw new Error('Guest install path is a symlink.');}catch(e){if(e.code!=='ENOENT')throw e;}if(dirname(p)===p)break;} }
const root='/opt/canaveral/bin';noLinks(root);fs.mkdirSync(root,{recursive:true,mode:0o755});
for(const h of helpers){
 const bytes=Buffer.from(h.parts.map(p=>{noLinks(p);return fs.readFileSync(p,'utf8');}).join(''),'base64');
 if(bytes.length!==h.bytes||createHash('sha256').update(bytes).digest('hex')!==h.sha256)throw new Error('Guest native payload digest differs.');
 const path=root+'/'+h.name;noLinks(path);const temporary=root+'/.'+h.name+'-'+randomUUID();const fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o755);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{fs.renameSync(temporary,path);const parent=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
}
`);
  const values = [...artifacts.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { artifacts: values, helpers, arch, sha256: sha(JSON.stringify(values)) };
}
export function main(args) {
  const { values } = parseArgs({ args, options: { output: { type: 'string' }, arch: { type: 'string' }, 'native-helper': { type: 'string' }, 'atspi-helper': { type: 'string' } } });
  if (!values.output || !isAbsolute(values.output)) throw new Error('Choose a new absolute --output manifest path.');
  const bundle = buildGuestBundle({ nativeHelper: values['native-helper'], atspiHelper: values['atspi-helper'], arch: values.arch });
  const fd = openSync(values.output, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(bundle.artifacts) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  console.log(JSON.stringify({ path: values.output, sha256: bundle.sha256, arch: bundle.arch, files: bundle.artifacts.length, installed: false, nativeAcceptance: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
