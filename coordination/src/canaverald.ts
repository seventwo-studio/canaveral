#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { main } from "./cli.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const status = await main(process.argv.slice(2), {}, "canaverald");
  if (status) {
    await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>(done => stream.write("", () => done()))));
    process.exit(status);
  }
}
