/** Offline checks of emitted modules. Never imports or executes package code. */
import { createRequire, isBuiltin } from 'node:module';
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
