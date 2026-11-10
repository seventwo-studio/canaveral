/** Parse JSON while rejecting duplicate object fields and nonfinite numbers. */
export function uniqueJSON(text) {
  const tokens = text.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]|\s+|./gs)?.filter(t => !/^\s+$/.test(t)) ?? [];
  let index = 0;
  function value() {
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set();
      if(tokens[index] === '}') { index++; return; }
      while(true) {
        const key = tokens[index++];
        if(!key?.startsWith('"')) throw new Error('Invalid JSON field.');
        const decoded = JSON.parse(key);
        if(keys.has(decoded)) throw new Error('Duplicate evidence field.');
        keys.add(decoded);
        if(tokens[index++]!==':') throw new Error('Invalid JSON field.');
        value();
        const separator = tokens[index++];
        if(separator==='}') return;
        if(separator!==',') throw new Error('Invalid JSON object.');
      }
    }
    if(token==='[') {
      if(tokens[index]===']') { index++; return; }
      while(true) { value(); const separator=tokens[index++]; if(separator===']') return; if(separator!==',') throw new Error('Invalid JSON array.'); }
    }
    if(token===undefined || !/^(?:"|-?\d|true$|false$|null$)/.test(token)) throw new Error('Invalid JSON value.');
    const parsed=JSON.parse(token);
    if(typeof parsed==='number' && !Number.isFinite(parsed)) throw new Error('Nonfinite JSON number.');
  }
  value();
  if(index!==tokens.length) throw new Error('Trailing JSON data.');
  return JSON.parse(text);
}
export function canonical(value) {
  if(typeof value==='number' && !Number.isFinite(value)) throw new Error('Nonfinite number.');
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value!==null && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  const result=JSON.stringify(value);
  if(result===undefined) throw new Error('Non-JSON value.');
  return result;
}
