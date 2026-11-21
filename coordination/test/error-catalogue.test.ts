import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FINDING_CODES } from "../src/control/diagnosis.ts";
import { EVENT_KINDS } from "../src/events.ts";

/** Where a stable error code can be written in source. The catalogue must list every one of them.
 *  1. A `code: "literal"` property, parameter type or default, including each member of a literal union.
 *  2. The second argument of an error constructor or helper whose first argument is its message.
 *  3. Any snake_case literal inside an error constructor's arguments (codes chosen by a conditional).
 *  4. The status-derived defaults in errors.ts.
 * Diagnosis findings use `code` for a different vocabulary; they are checked against docs/doctor.md below. */
const NOT_ERRORS: Record<string, string> = {
  "src/control/diagnosis.ts": "doctor finding codes",
  "src/observability-cli.ts": "doctor finding codes and its internal probe result",
};
export function sourceErrorCodes(root: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (code: string, file: string) => { if (!found.has(code)) found.set(code, new Set()); found.get(code)!.add(file); };
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      const file = "src" + path.slice(root.length).replaceAll("\\", "/");
      if (!path.endsWith(".ts") || Object.hasOwn(NOT_ERRORS, file)) continue;
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/\bcode\??(?:: ?| = )((?:["'][a-z][a-z0-9_]*["'](?: ?\| ?)?)+)/g)) for (const literal of match[1]!.matchAll(/["']([a-z][a-z0-9_]*)["']/g)) add(literal[1]!, file);
      // A constructor's second argument is its code whatever its shape; a helper's must look like one (snake_case).
      for (const match of text.matchAll(/(new \w*Error|\w+)\(\s*(?:"[^"\n]* [^"\n]*"|'[^'\n]* [^'\n]*'|`[^`\n]* [^`\n]*`)\s*,\s*["']([a-z][a-z0-9_]*)["']\s*[,)]/g)) {
        if (match[1]!.startsWith("new ") || match[2]!.includes("_")) add(match[2]!, file);
      }
      for (const match of text.matchAll(/new \w*Error\(/g)) {
        for (const literal of text.slice(match.index, match.index + 320).split(/;\s|\n/, 1)[0]!.matchAll(/["']([a-z][a-z0-9]*(?:_[a-z0-9]+)+)["']/g)) add(literal[1]!, file);
      }
      if (file === "src/errors.ts") {
        const defaults = /const codes[^{]*\{([^}]*)\}/.exec(text);
        assert.ok(defaults, "errors.ts keeps its status-derived default codes");
        for (const literal of defaults[1]!.matchAll(/"([a-z_]+)"/g)) add(literal[1]!, file);
        for (const literal of text.matchAll(/\?\? "([a-z_]+)"/g)) add(literal[1]!, file);
      }
    }
  };
  walk(root);
  return found;
}
/** Catalogue rows are `| \`code\` | status | meaning | retry |`. */
function catalogued(document: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of document.split("\n")) {
    const cells = line.split("|").map(cell => cell.trim());
    const code = /^`([a-z][a-z0-9_]*)`$/.exec(cells[1] ?? "")?.[1];
    if (code) { assert.ok(!rows.has(code), `${code} is catalogued twice`); rows.set(code, cells.slice(2, -1)); }
  }
  return rows;
}
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repository, path), "utf8");

test("every stable error code used in source is catalogued with a status, meaning and retry guidance", () => {
  const source = sourceErrorCodes(join(repository, "coordination/src")), catalogue = catalogued(read("docs/error-codes.md"));
  assert.ok(source.size > 60, "the scan still finds the controller's codes");
  for (const expected of ["capacity_unavailable", "request_conflict", "transport_interrupted", "tls_verification_failed", "invalid_request", "request_failed", "video_incomplete", "event_kind_unknown", "content_type_invalid", "invalid_configuration", "session_upgrade_refused"]) assert.ok(source.has(expected), expected);
  const missing = [...source].filter(([code]) => !catalogue.has(code)).map(([code, files]) => `${code} (${[...files].join(", ")})`);
  assert.deepEqual(missing, [], "add these codes to docs/error-codes.md");
  const stale = [...catalogue.keys()].filter(code => !source.has(code));
  assert.deepEqual(stale, [], "docs/error-codes.md lists codes that no source uses");
  for (const [code, cells] of catalogue) {
    assert.equal(cells.length, 3, `${code} needs status, meaning and retry columns`);
    assert.match(cells[0]!, /^(?:\d{3}|client|receipt)(?:, (?:\d{3}|client|receipt))*$/, `${code} status`);
    assert.ok(cells[1]!.length >= 20 && cells[2]!.length >= 10, `${code} needs a meaning and retry guidance`);
  }
});

test("doctor finding codes and event kinds are documented where their contracts say", () => {
  const doctor = read("docs/doctor.md"), events = read("docs/events.md");
  for (const code of Object.keys(FINDING_CODES)) assert.ok(doctor.includes("`" + code + "`"), `docs/doctor.md lacks ${code}`);
  for (const documented of doctor.matchAll(/^\| `([a-z_]+)` \|/gm)) assert.ok(Object.hasOwn(FINDING_CODES, documented[1]!), `docs/doctor.md documents unknown finding ${documented[1]}`);
  for (const kind of Object.keys(EVENT_KINDS)) assert.ok(events.includes("`" + kind + "`"), `docs/events.md lacks ${kind}`);
  for (const documented of events.matchAll(/^\| `([a-z]+\.[a-z_]+)` \|/gm)) assert.ok(Object.hasOwn(EVENT_KINDS, documented[1]!), `docs/events.md documents unknown kind ${documented[1]}`);
});
