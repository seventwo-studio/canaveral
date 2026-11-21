import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { FINDING_CODES } from "../src/control/diagnosis.ts";
import { EVENT_KINDS } from "../src/events.ts";

/** Finds the stable error codes written in `coordination/src` by parsing it with the TypeScript
 * compiler, so line breaks, punctuation inside messages and argument order do not matter.
 *
 * A code position is one of:
 *  1. the value of a property named `code` (object literal, shorthand, or `x.code = …`), and the
 *     literal types or default of a field or parameter named `code`;
 *  2. a constructor argument bound to a parameter named `code`, for a class declared in the same
 *     file or imported by name, including an inherited constructor;
 *  3. an argument of a helper function whose parameter reaches a code position (directly or through
 *     another helper), for a helper declared in the same file or imported by name;
 *  4. the status-derived defaults in errors.ts.
 * The value at a code position is followed through string literals, both branches of `?:`, `??`
 * and `||`, and constants declared in the same file. A template literal there must have its
 * expansions declared in TEMPLATE_CODES. A value that is read from another error (`known.code`) is
 * forwarding and adds nothing. Anything else fails the test until it is resolved or acknowledged in
 * ACKNOWLEDGED, so a code position this scan cannot read is never silently skipped.
 *
 * Not caught: a code produced outside a code position (for example a `reason` field that some later
 * code copies into `code`), a helper reached as a method of an object from another file, a code
 * received at run time from a guest, runner or native helper, and anything outside coordination/src
 * (Rust, Swift, the dashboard). docs/error-codes.md says the same.
 */
const SHAPE = /^[a-z][a-z0-9_]{0,63}$/;
/** Files whose `code` is another vocabulary, checked against its own page below. */
const OTHER_VOCABULARIES: Record<string, string> = {
  "src/control/diagnosis.ts": "doctor finding codes (docs/doctor.md)",
  "src/observability-cli.ts": "doctor finding codes and the internal connection probe result",
};
/** Every template literal at a code position, with exactly the codes it can produce. */
const TEMPLATE_CODES: Record<string, string[]> = {
  "src/agent-session.ts request_${}": ["request_cancelled", "request_rejected"],
  "src/control/transfers.ts ${}_publication_uncertain": ["upload_publication_uncertain", "download_publication_uncertain"],
  "src/control/transfers.ts ${}_temporary_cleanup_failed": ["upload_temporary_cleanup_failed", "download_temporary_cleanup_failed"],
  // InputState without "owned": busy, stale, reset-uncertain.
  "src/guest/display.ts input_${}": ["input_busy", "input_stale", "input_reset_uncertain"],
};
/** Code positions that are not error codes, or that this scan cannot follow. Each says why, and names
 * the codes it stands for when the value comes from somewhere the scan does not look. */
const ACKNOWLEDGED: Record<string, { why: string; codes?: string[] }> = {
  "src/control/event-stream.ts stream_lifetime": { why: "end-of-stream code of the event stream, documented in docs/events.md" },
  "src/control/event-stream.ts controller_closing": { why: "end-of-stream code of the event stream, documented in docs/events.md" },
  "src/runtime-process.ts child.exitCode": { why: "a process exit status in a helper result, not an error code" },
  "src/consumer-client.ts clean(json[\"code\"]).slice(0, 100)": { why: "the controller's own reply code, forwarded after redaction" },
  "src/linux-transfers.ts a.reason": { why: "a `reason` chosen by the lease authority callback in linux-leases.ts and copied into the receipt code", codes: ["data_channel_lost"] },
};

interface Source { file: string; node: ts.SourceFile }
type Value = { code: string } | { template: string } | { unresolved: string; line: number };
type FunctionNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.ConstructorDeclaration;
const isFunction = (node: ts.Node): node is FunctionNode => ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node);
const named = (name: ts.Node | undefined, text: string): boolean => !!name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === text;
const parameterNames = (node: FunctionNode): string[] => node.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : "");
function walk(node: ts.Node, visit: (node: ts.Node) => void): void { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}
function sources(root: string): Source[] {
  const found: Source[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) { visit(path); continue; }
      const file = "src" + path.slice(root.length).replaceAll("\\", "/");
      if (path.endsWith(".ts") && !Object.hasOwn(OTHER_VOCABULARIES, file)) found.push({ file, node: ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true) });
    }
  };
  visit(root);
  return found;
}

export interface ErrorCodeScan { codes: Map<string, Set<string>>; problems: string[] }
export function scanErrorCodes(root: string): ErrorCodeScan {
  const all = sources(root), codes = new Map<string, Set<string>>(), problems: string[] = [];
  // Names are resolved per file: a declaration in the file, else a named import from another source file.
  // Two unrelated classes or helpers that share a name in different files are therefore never confused.
  const imports = new Map<string, string>();
  for (const { file, node } of all) for (const statement of node.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const target = posix.normalize(posix.join(posix.dirname(file), statement.moduleSpecifier.text));
    for (const element of bindings.elements) imports.set(`${file} ${element.name.text}`, `${target} ${(element.propertyName ?? element.name).text}`);
  }
  const resolve = <T>(table: Map<string, T>, file: string, name: string | undefined): T | undefined => {
    for (let key = name === undefined ? undefined : `${file} ${name}`, depth = 0; key !== undefined && depth < 4; key = imports.get(key), depth++) { const found = table.get(key); if (found !== undefined) return found; }
    return undefined;
  };
  // Constructors with a parameter named `code`, by class, following `extends` to an inherited constructor.
  const classes = new Map<string, { file: string; parent?: string; parameters?: string[] }>();
  for (const { file, node } of all) walk(node, child => {
    if (!ts.isClassDeclaration(child) || !child.name) return;
    const parent = child.heritageClauses?.flatMap(clause => clause.token === ts.SyntaxKind.ExtendsKeyword ? clause.types : [])[0]?.expression;
    const own = child.members.find(ts.isConstructorDeclaration);
    classes.set(`${file} ${child.name.text}`, { file, ...(parent && ts.isIdentifier(parent) ? { parent: parent.text } : {}), ...(own ? { parameters: parameterNames(own) } : {}) });
  });
  const constructorParameters = (file: string, name: string | undefined): string[] => {
    for (let depth = 0; name !== undefined && depth < 8; depth++) {
      const known = resolve(classes, file, name);
      if (!known) return [];
      if (known.parameters) return known.parameters;
      file = known.file; name = known.parent;
    }
    return [];
  };
  const callee = (node: ts.CallExpression): string | undefined => ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;

  // Helpers: (file, function name) -> indexes of parameters that reach a code position.
  const helpers = new Map<string, Set<number>>();
  const functionName = (node: FunctionNode): string | undefined => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent)) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
    return undefined;
  };
  const helperIndexes = (file: string, name: string | undefined): Set<number> | undefined => resolve(helpers, file, name);
  for (let changed = true; changed;) {
    changed = false;
    for (const { file, node } of all) walk(node, child => {
      if (!isFunction(child) || !child.body) return;
      const name = ts.isConstructorDeclaration(child) ? undefined : functionName(child), parameters = parameterNames(child);
      if (name === undefined) return;
      const mark = (parameter: string): void => {
        const index = parameters.indexOf(parameter);
        if (index < 0) return;
        const indexes = helpers.get(`${file} ${name}`) ?? new Set<number>();
        if (!indexes.has(index)) { indexes.add(index); helpers.set(`${file} ${name}`, indexes); changed = true; }
      };
      const reaches = (expression: ts.Expression | undefined): void => {
        if (!expression) return;
        const inner = unwrap(expression);
        if (ts.isIdentifier(inner)) mark(inner.text);
        else if (ts.isConditionalExpression(inner)) { reaches(inner.whenTrue); reaches(inner.whenFalse); }
        else if (ts.isBinaryExpression(inner) && (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { reaches(inner.left); reaches(inner.right); }
      };
      walk(child.body, inside => {
        if (ts.isPropertyAssignment(inside) && named(inside.name, "code")) reaches(inside.initializer);
        if (ts.isShorthandPropertyAssignment(inside) && inside.name.text === "code") mark("code");
        if (ts.isBinaryExpression(inside) && inside.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(inside.left) && inside.left.name.text === "code") reaches(inside.right);
        if (ts.isNewExpression(inside) && ts.isIdentifier(inside.expression)) constructorParameters(file, inside.expression.text).forEach((parameter, index) => { if (parameter === "code") reaches(inside.arguments?.[index]); });
        if (ts.isCallExpression(inside)) for (const index of helperIndexes(file, callee(inside)) ?? []) reaches(inside.arguments[index]);
      });
    });
  }

  for (const { file, node } of all) {
    const constants = new Map<string, ts.Expression>();
    walk(node, child => { if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer) constants.set(child.name.text, child.initializer); });
    const isParameter = (identifier: ts.Identifier): boolean => {
      for (let parent: ts.Node | undefined = identifier.parent; parent; parent = parent.parent) if (isFunction(parent) && parameterNames(parent).includes(identifier.text)) return true;
      return false;
    };
    const values = (expression: ts.Expression | undefined, depth = 0): Value[] => {
      if (!expression) return [];
      const inner = unwrap(expression);
      if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return [{ code: inner.text }];
      // An exit status or a null is not an error code.
      if (ts.isNumericLiteral(inner) || ts.isPrefixUnaryExpression(inner) || inner.kind === ts.SyntaxKind.NullKeyword) return [];
      // A table of codes indexed in place, such as defaults by status: every entry can be produced.
      const table = ts.isElementAccessExpression(inner) ? unwrap(inner.expression) : undefined;
      if (table && ts.isObjectLiteralExpression(table)) return table.properties.flatMap(property => ts.isPropertyAssignment(property) ? values(property.initializer, depth) : []);
      if (ts.isTemplateExpression(inner)) return [{ template: inner.head.text + inner.templateSpans.map(span => "${}" + span.literal.text).join("") }];
      if (ts.isConditionalExpression(inner)) return [...values(inner.whenTrue, depth), ...values(inner.whenFalse, depth)];
      if (ts.isBinaryExpression(inner) && (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...values(inner.left, depth), ...values(inner.right, depth)];
      // Reading another error's code, or the defaults table, forwards a code that is written elsewhere.
      if ((ts.isPropertyAccessExpression(inner) && inner.name.text === "code") || (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "codes")) return [];
      if (ts.isIdentifier(inner)) {
        // A parameter gets its values from the callers, through the helper pass above.
        if (inner.text === "undefined" || isParameter(inner)) return [];
        const constant = constants.get(inner.text);
        if (constant && depth < 4) return values(constant, depth + 1);
      }
      return [{ unresolved: inner.getText(node).replace(/\s+/g, " ").slice(0, 80), line: node.getLineAndCharacterOfPosition(inner.getStart(node)).line + 1 }];
    };
    const record = (found: Value[]): void => {
      for (const value of found) {
        if ("unresolved" in value) {
          for (const code of ACKNOWLEDGED[`${file} ${value.unresolved}`]?.codes ?? []) { const files = codes.get(code) ?? new Set<string>(); files.add(file); codes.set(code, files); }
          if (!Object.hasOwn(ACKNOWLEDGED, `${file} ${value.unresolved}`)) problems.push(`${file}:${value.line}: cannot tell which codes \`${value.unresolved}\` produces; resolve it or acknowledge it`);
          continue;
        }
        const produced = "template" in value ? TEMPLATE_CODES[`${file} ${value.template}`] : [value.code];
        if (!produced) { problems.push(`${file}: declare the codes of the template \`${(value as { template: string }).template}\` in TEMPLATE_CODES`); continue; }
        for (const code of produced) {
          if (!SHAPE.test(code) || Object.hasOwn(ACKNOWLEDGED, `${file} ${code}`)) continue;
          const files = codes.get(code) ?? new Set<string>(); files.add(file); codes.set(code, files);
        }
      }
    };
    walk(node, child => {
      if (ts.isPropertyAssignment(child) && named(child.name, "code")) record(values(child.initializer));
      else if (ts.isShorthandPropertyAssignment(child) && child.name.text === "code") record(values(child.name));
      else if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(child.left) && child.left.name.text === "code") record(values(child.right));
      else if ((ts.isPropertySignature(child) || ts.isPropertyDeclaration(child) || ts.isParameter(child)) && named(child.name, "code")) {
        const literals = (type: ts.TypeNode | undefined): string[] => !type ? [] : ts.isUnionTypeNode(type) ? type.types.flatMap(literals) : ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal) ? [type.literal.text] : [];
        record(literals(child.type).map(code => ({ code })));
        if (!ts.isPropertySignature(child) && child.initializer) record(values(child.initializer));
      } else if (ts.isNewExpression(child) && ts.isIdentifier(child.expression)) {
        constructorParameters(file, child.expression.text).forEach((parameter, index) => { if (parameter === "code") record(values(child.arguments?.[index])); });
      } else if (ts.isCallExpression(child)) {
        if (child.expression.kind === ts.SyntaxKind.SuperKeyword) {
          let owner: ts.Node | undefined = child.parent;
          while (owner && !ts.isClassDeclaration(owner)) owner = owner.parent;
          const parent = owner && ts.isClassDeclaration(owner) && owner.name ? classes.get(`${file} ${owner.name.text}`)?.parent : undefined;
          constructorParameters(file, parent).forEach((parameter, index) => { if (parameter === "code") record(values(child.arguments[index])); });
        } else for (const index of helperIndexes(file, callee(child)) ?? []) record(values(child.arguments[index]));
      } else if (file === "src/errors.ts" && ts.isVariableDeclaration(child) && named(child.name, "codes") && child.initializer && ts.isObjectLiteralExpression(child.initializer)) {
        for (const property of child.initializer.properties) if (ts.isPropertyAssignment(property)) record(values(property.initializer));
      }
    });
  }
  return { codes, problems };
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
  const scan = scanErrorCodes(join(repository, "coordination/src")), catalogue = catalogued(read("docs/error-codes.md"));
  assert.deepEqual(scan.problems, [], "every code position must be readable by the scan");
  assert.ok(scan.codes.size > 80, "the scan still finds the controller's codes");
  // One code per way of writing it: an option, a constructor argument, a `??` fallback, a helper argument, a template,
  // a message that contains "; ", a literal union, a parameter default and a status-derived default.
  for (const expected of ["capacity_unavailable", "tls_verification_failed", "operation_incomplete", "invalid_cursor", "upload_temporary_cleanup_failed",
    "download_destination_failed", "connection_failed", "invalid_configuration", "request_failed", "content_type_invalid", "authorization_lost", "data_channel_lost"]) assert.ok(scan.codes.has(expected), expected);
  const missing = [...scan.codes].filter(([code]) => !catalogue.has(code)).map(([code, files]) => `${code} (${[...files].join(", ")})`).sort();
  assert.deepEqual(missing, [], "add these codes to docs/error-codes.md");
  const stale = [...catalogue.keys()].filter(code => !scan.codes.has(code));
  assert.deepEqual(stale, [], "docs/error-codes.md lists codes that no source uses");
  for (const [code, cells] of catalogue) {
    assert.equal(cells.length, 3, `${code} needs status, meaning and retry columns`);
    assert.match(cells[0]!, /^(?:\d{3}|client|receipt)(?:, (?:\d{3}|client|receipt))*$/, `${code} status`);
    assert.ok(cells[1]!.length >= 20 && cells[2]!.length >= 10, `${code} needs a meaning and retry guidance`);
  }
  // Declared expansions and acknowledgements must still correspond to something in the source.
  const text = new Map(sources(join(repository, "coordination/src")).map(source => [source.file, source.node.text]));
  for (const key of [...Object.keys(TEMPLATE_CODES), ...Object.keys(ACKNOWLEDGED)]) {
    const [file, value] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    // A plain value must still be in the file; each literal piece of a template must still adjoin a substitution.
    const body = text.get(file) ?? "", pieces = value.split("${}");
    const present = pieces.length === 1 ? body.includes(value)
      : pieces.every((piece, index) => piece === "" || body.includes((index > 0 ? "}" : "") + piece + (index < pieces.length - 1 ? "${" : "")));
    assert.ok(present, `${key} no longer matches the source`);
  }
  for (const [key, entry] of Object.entries(ACKNOWLEDGED)) for (const code of entry.codes ?? []) {
    assert.ok([...text.values()].some(body => body.includes(`'${code}'`) || body.includes(`"${code}"`)), `${key} names ${code}, which no source writes any more`);
  }
});

test("the scan reads the shapes a code can take, and refuses the ones it cannot", () => {
  // The scan runs on a temporary source tree so each rule is pinned independently of the repository.
  const root = mkdtempSync(join(tmpdir(), "canaveral-error-scan-")), source = join(root, "src");
  try {
    mkdirSync(source);
    writeFileSync(join(source, "errors.ts"), `export class ServiceError extends Error { constructor(message: string, status = 409, options: { code?: string } = {}) { super(message); } }
      export class SdkError extends Error { constructor(message: string, readonly code = "default_code") { super(message); } }
      export class Narrow extends SdkError {}
      export function refuse(code: string, status = 400): never { throw new ServiceError(code, status, { code }); }`);
    writeFileSync(join(source, "use.ts"), `import { Narrow, refuse, SdkError, ServiceError } from "./errors.ts";
      const FIXED = "from_constant";
      const invalid = (message: string, code = "helper_default") => new SdkError(message, code);
      function wrap(reason: string) { return invalid("Wrapped; with a semicolon.", reason); }
      export function sample(known: { code?: string } | undefined, kind: "a" | "b", flag: boolean) {
        new ServiceError("An option; split over\\n lines.", 409, {
          code: "option_code",
        });
        new SdkError("Second argument.", "constructor_code");
        new Narrow("Inherited constructor.", flag ? "branch_one" : "branch_two");
        const reply = { error: "Not confirmed.", code: known?.code ?? "fallback_code" };
        refuse("exported_helper");
        invalid("A helper argument.", "local_helper");
        wrap("through_two_helpers");
        const e = new Error("x") as Error & { code?: string }; e.code = FIXED;
        return [reply, { code: \`\${kind}_templated\` }];
      }
      export interface Shape { code: "union_one" | "union_two" }`);
    const scan = scanErrorCodes(source);
    assert.deepEqual([...scan.codes.keys()].sort(), ["branch_one", "branch_two", "constructor_code", "default_code", "exported_helper", "fallback_code", "from_constant",
      "helper_default", "local_helper", "option_code", "through_two_helpers", "union_one", "union_two"]);
    assert.deepEqual(scan.problems, ["src/use.ts: declare the codes of the template `${}_templated` in TEMPLATE_CODES"]);
    writeFileSync(join(source, "opaque.ts"), `declare function compute(): string; export const reply = { code: compute() };`);
    assert.ok(scanErrorCodes(source).problems.includes("src/opaque.ts:1: cannot tell which codes `compute()` produces; resolve it or acknowledge it"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor finding codes, event kinds and stream end codes are documented where their contracts say", () => {
  const doctor = read("docs/doctor.md"), events = read("docs/events.md");
  for (const code of Object.keys(FINDING_CODES)) assert.ok(doctor.includes("`" + code + "`"), `docs/doctor.md lacks ${code}`);
  for (const documented of doctor.matchAll(/^\| `([a-z_]+)` \|/gm)) assert.ok(Object.hasOwn(FINDING_CODES, documented[1]!), `docs/doctor.md documents unknown finding ${documented[1]}`);
  for (const kind of Object.keys(EVENT_KINDS)) assert.ok(events.includes("`" + kind + "`"), `docs/events.md lacks ${kind}`);
  for (const documented of events.matchAll(/^\| `([a-z]+\.[a-z_]+)` \|/gm)) assert.ok(Object.hasOwn(EVENT_KINDS, documented[1]!), `docs/events.md documents unknown kind ${documented[1]}`);
  for (const key of Object.keys(ACKNOWLEDGED).filter(key => key.startsWith("src/control/event-stream.ts "))) assert.ok(events.includes("`" + key.split(" ")[1] + "`"), `docs/events.md lacks the stream end code ${key.split(" ")[1]}`);
});
