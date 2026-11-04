import { readFileSync } from "node:fs";

/** Test-only preload (`node --import`): wall-clock reads come from a fixture file holding Unix
 * seconds, so expiry boundaries are exact without sleeps. Worker threads inherit the preload.
 * Production entry points never load this module.
 */
const file = process.env.CANAVERAL_FIXTURE_CLOCK_FILE;
if (file) Date.now = () => Math.round(Number(readFileSync(file, "utf8")) * 1000);
