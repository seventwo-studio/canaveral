/** JSON.parse alone silently replaces duplicate fields. Bound depth and reject them. */
export function strictJson(bytes: Buffer): unknown {
  const invalid = () => new SyntaxError("Invalid or ambiguous JSON.");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const whitespace = (): void => { while (/[\x20\t\r\n]/.test(source[at] ?? "!")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === "\\") { at++; continue; }
      if (char === '"') return JSON.parse(source.slice(start, at)) as string;
    }
    throw invalid();
  };
  const value = (depth: number): void => {
    if (depth > 64) throw invalid();
    whitespace();
    if (source[at] === '"') { string(); return; }
    if (source[at] === "{" || source[at] === "[") {
      const isObject = source[at++] === "{", end = isObject ? "}" : "]", seen = new Set<string>();
      whitespace(); if (source[at] === end) { at++; return; }
      for (;;) {
        whitespace();
        if (isObject) {
          if (source[at] !== '"') throw invalid();
          const key = string(); if (seen.has(key)) throw invalid(); seen.add(key);
          whitespace(); if (source[at++] !== ":") throw invalid();
        }
        value(depth + 1); whitespace();
        const separator = source[at++];
        if (separator === end) return;
        if (separator !== ",") throw invalid();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!token) throw invalid(); at += token[0].length;
  };
  value(0); whitespace(); if (at !== source.length) throw invalid();
  return JSON.parse(source) as unknown;
}
