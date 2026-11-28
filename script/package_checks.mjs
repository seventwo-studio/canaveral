/** Offline checks of emitted modules. Never imports or executes package code. */
import { createRequire, isBuiltin } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
const require = createRequire(new URL('../coordination/package.json', import.meta.url));
const ts = require('typescript');

export function moduleReferences(source, file = 'module.js') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`Invalid emitted module: ${file}`);
  const references = [];
  function visit(node) {
    let value;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) value = node.arguments[0];
    if (value) references.push(ts.isStringLiteralLike(value) ? { specifier: value.text, start: value.getStart(tree), end: value.end } : { computed: true });
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return references;
}

/** Checks every supplied JS module, including lazy entrypoints, against this exact file set.
 * Computed dispatch cannot be resolved statically; isolated import smoke tests cover shipped entries.
 */
export function checkModuleClosure(files, { rejectComputed = false } = {}) {
  for (const [file, source] of files) {
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    for (const ref of moduleReferences(source, file)) {
      if (ref.computed) { if (rejectComputed) throw new Error(`Computed module dependency: ${file}`); continue; }
      if (isBuiltin(ref.specifier)) continue;
      if (!ref.specifier.startsWith('./') && !ref.specifier.startsWith('../')) throw new Error(`Unpackaged module dependency: ${file}: ${ref.specifier}`);
      const target = posix.normalize(posix.join(posix.dirname(file), ref.specifier));
      if (!files.has(target)) throw new Error(`Missing module dependency: ${file}: ${ref.specifier}`);
    }
  }
}

/** Refuses packaging when the runtime qualification state is inconsistent. Runs
 * when this module loads, so every flow that imports it (CLI preparation, runtime
 * releases, guest bundles) is gated. It fails closed: without the promotions and
 * the qualification tool there is nothing to check the embedded table against.
 * A source checkout gets the full check. A container build stage that copies only
 * qualification/promotions.json and script/qualification.mjs gets the table check;
 * the release workflow runs the full check and API verification before building.
 */
export async function checkQualification(root = new URL('../', import.meta.url)) {
  const at = path => new URL(path, root);
  const tool = at('script/qualification.mjs');
  const promotions = at('qualification/promotions.json');
  if (!existsSync(tool) || !existsSync(promotions)) {
    throw new Error('Runtime qualification inputs are missing. Copy qualification/promotions.json and script/qualification.mjs into the build.');
  }
  const qualification = await import(tool.href);
  if (existsSync(at('qualification/schema')) && existsSync(at('crates/model-execution/src/runtime-pins.json'))) {
    const { errors } = qualification.check(fileURLToPath(root));
    if (errors.length) throw new Error(`Runtime qualification check failed:\n  ${errors.join('\n  ')}`);
    return 'full';
  }
  const table = qualification.PATHS.tsTable;
  const expected = qualification.generated(JSON.parse(readFileSync(promotions, 'utf8')))[table];
  if (!existsSync(at(table)) || readFileSync(at(table), 'utf8') !== expected) {
    throw new Error(`${table} does not match qualification/promotions.json; run node script/qualification.mjs sync`);
  }
  return 'table';
}
await checkQualification();
