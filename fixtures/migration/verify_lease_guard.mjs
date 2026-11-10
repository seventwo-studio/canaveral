#!/usr/bin/env node
/** Execute the shared trace and persisted wire assertions in the Rust owner. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result=spawnSync('cargo',['test','-p','canaveral-execution-core','--test','lease_guard','--locked','-j','2'],{
  cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:'inherit',env:{...process.env,CARGO_BUILD_JOBS:'2'},
});
if(result.error) {console.error(result.error.message);process.exitCode=1;} else process.exitCode=result.status??1;
