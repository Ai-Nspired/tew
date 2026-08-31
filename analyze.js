const fs = require('fs');
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');
const openPos = 10729;
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}
const escaped = src.substring(openPos + 1, pos);

// Find all escaped \${ patterns
let idx = 0;
const results = [];
while ((idx = escaped.indexOf('\\${', idx)) !== -1) {
  results.push(escaped.substring(Math.max(0,idx-20), idx+20).replace(/\n/g, ' '));
  idx++;
}
console.log('Escaped ${ count:', results.length);
console.log('First 10:');
results.slice(0, 10).forEach((r,i) => console.log(i+1, r));

// Now find unescaped ${ (template literal interpolation in worker)
idx = 0;
const unescaped = [];
for (let i = 0; i < escaped.length; i++) {
  if (escaped[i] === '$' && escaped[i+1] === '{') {
    if (i > 0 && escaped[i-1] === '\\') { /* escaped */ }
    else unescaped.push(escaped.substring(Math.max(0,i-20), i+20).replace(/\n/g, ' '));
    i++;
  }
}
console.log('Unescaped ${ count:', unescaped.length);
console.log('First 10:');
unescaped.slice(0, 10).forEach((r,i) => console.log(i+1, r));
