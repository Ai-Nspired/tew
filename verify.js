const fs = require('fs');
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');
const original = fs.readFileSync('/tmp/tew/index.html', 'utf8');

const idx = src.indexOf('var INDEX_HTML = `');
const openPos = src.indexOf('`', idx);
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}
const escaped = src.substring(openPos + 1, pos);

// Unescape
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
    i++;
  } else {
    raw += escaped[i];
  }
}

if (raw === original) {
  console.log('ROUND-TRIP PERFECT MATCH');
} else {
  console.log('MISMATCH');
  console.log('Expected:', original.length, 'bytes');
  console.log('Got:', raw.length, 'bytes');
  for (let i = 0; i < Math.min(raw.length, original.length); i++) {
    if (raw[i] !== original[i]) {
      console.log('First diff at', i, ':', JSON.stringify(raw.substring(Math.max(0,i-10), i+10)), 'vs', JSON.stringify(original.substring(Math.max(0,i-10), i+10)));
      break;
    }
  }
}
