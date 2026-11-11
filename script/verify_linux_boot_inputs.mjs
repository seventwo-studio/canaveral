#!/usr/bin/env node
// Read-only preflight of the existing assembler recipe. Rust owns validation.
// Evidence JSON: {version:1,files:[{role:"debian.release",path:"Release",size:123}]}
// Supply every provenance pin: dotted field names and zero-based array indices
// (debian.packages[0], rust[0], kernelPatches[0], etc). SHA256 comes from recipe.
// Exit zero means local bytes match pins; the JSON report retains trust/build gates.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function verificationCommand(args) {
  if (args.length !== 6 || args[0] !== '--recipe' || args[2] !== '--inputs' || args[4] !== '--evidence'
      || [args[1], args[3], args[5]].some(value => !value || value.startsWith('--'))) {
    throw new Error('usage: node script/verify_linux_boot_inputs.mjs --recipe FILE --inputs DIR --evidence FILE');
  }
  return ['run', '--locked', '--offline', '-j2', '--quiet', '--manifest-path',
    fileURLToPath(new URL('../Cargo.toml', import.meta.url)),
    '-p', 'canaveral-boot-bundle', '--bin', 'canaveral-boot-bundle', '--',
    'verify-inputs', ...args];
}

export function run(args, spawn = spawnSync) {
  const result = spawn('cargo', verificationCommand(args), { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error('Boot-input verifier interrupted.');
  return result.status;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
