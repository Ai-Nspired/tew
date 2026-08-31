const fs = require('fs');

// Read the current worker.js (modified version with my changes already in it)
// and the new index.html
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');
const html = fs.readFileSync('/tmp/tew/index.html', 'utf8');

// Escape for embedding in JS backtick template literal
// Order matters: backslashes first, then backticks, then ${}
const escaped = html
  .replace(/\\/g, '\\\\')    // \ → \\
  .replace(/`/g, '\\`')      // ` → \`
  .replace(/\$\{/g, '\\${'); // ${ → \${

// Find INDEX_HTML boundaries
const idx = src.indexOf('var INDEX_HTML');
const openPos = src.indexOf('`', idx);
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}

const output = src.substring(0, openPos + 1) + escaped + src.substring(pos);
fs.writeFileSync('/tmp/tew/worker.js', output);
console.log('Built worker.js:', output.length, 'bytes');
console.log('INDEX_HTML replaced:', pos - openPos - 1, '→', escaped.length, 'bytes');
