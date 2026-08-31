const fs = require('fs');

// Read the raw HTML
const raw = fs.readFileSync('/tmp/tew/index.html', 'utf8');

// Escape for embedding in backtick template literal (same as build.js)
const escaped = raw
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

// Read the current worker.js
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');

// Find the original escaped content
const idx = src.indexOf('var INDEX_HTML = `');
const openPos = src.indexOf('`', idx);
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}
const originalEscaped = src.substring(openPos + 1, pos);

// Compare
if (escaped === originalEscaped) {
  console.log('ROUND-TRIP MATCH: build.js logic is CORRECT');
} else {
  console.log('MISMATCH');
  console.log('Original length:', originalEscaped.length);
  console.log('New length:', escaped.length);
  // Find first difference
  for (let i = 0; i < Math.min(escaped.length, originalEscaped.length); i++) {
    if (escaped[i] !== originalEscaped[i]) {
      console.log('First diff at char', i);
      console.log('New:', JSON.stringify(escaped.substring(Math.max(0,i-20), i+20)));
      console.log('Orig:', JSON.stringify(originalEscaped.substring(Math.max(0,i-20), i+20)));
      break;
    }
  }
}
