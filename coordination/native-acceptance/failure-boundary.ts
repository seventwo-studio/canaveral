import {writeSync} from 'node:fs';
// Imported first by the entry point, before configuration or evidence is read.
// Never inspect the thrown value: even its message/cause can contain secrets.
export function internalFailure(): void {
  process.exitCode = 1;
  try { writeSync(2, 'native acceptance failed: internal error (details withheld)\n'); } catch {}
}
function fatal(): never {
  internalFailure();
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
// Node's default warning listener prints the warning (and possibly its stack).
process.removeAllListeners('warning');
process.on('warning', fatal);

export function guardEvidenceWrite(write: () => void): void {
  try { write(); }
  catch {
    internalFailure();
    throw new Error('native acceptance failed: internal error (details withheld)');
  }
}
