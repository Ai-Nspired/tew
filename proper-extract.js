const fs = require('fs');
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');

const startMarker = 'var INDEX_HTML = `';
const idx = src.indexOf(startMarker);
const openPos = src.indexOf('`', idx);

let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}

const escaped = src.substring(openPos + 1, pos);

// The escaped content needs to be unescaped to get the raw HTML
// In the JS source inside the template literal:
//   \\ -> \     (escaped backslash)
//   \` -> `     (escaped backtick) 
//   \$ -> $     (escaped dollar)
//   \n -> newline, \t -> tab, etc.

let raw = '';
for (let i = 0; i < escaped.length; i++) {
  if (escaped[i] === '\\' && i + 1 < escaped.length) {
    const next = escaped[i + 1];
    if (next === '\\') { raw += '\\'; }
    else if (next === '`') { raw += '`'; }
    else if (next === '$') { raw += '$'; }
    else if (next === 'n') { raw += '\n'; }
    else if (next === 't') { raw += '\t'; }
    else if (next === 'r') { raw += '\r'; }
    else { raw += escaped[i]; }
    i++; // skip next char
  } else {
    raw += escaped[i];
  }
}

fs.writeFileSync('/tmp/tew/index.html', raw);
console.log('Extracted:', raw.length, 'bytes');
