const fs = require('fs');
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');

// Extract original escaped content
const openPos = 10729;
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}
const originalEscaped = src.substring(openPos + 1, pos);

const raw = fs.readFileSync('/tmp/tew/index.html', 'utf8');

// Show around char 24090 in original
console.log('=== ORIGINAL around char 24090 ===');
console.log(JSON.stringify(originalEscaped.substring(24080, 24120)));
console.log('=== RAW around the same area ===');
// Need to find the corresponding area in raw - harder because lengths differ
// Let's just check what the raw HTML has near where this maps to

// Better: search for the pattern
const searchStr = '/api';
let idx = 0;
while ((idx = raw.indexOf(searchStr, idx)) !== -1) {
  const context = raw.substring(Math.max(0,idx-30), idx+30);
  if (context.includes('${')) {
    console.log('Raw:', JSON.stringify(context));
    console.log('---');
  }
  idx++;
}
