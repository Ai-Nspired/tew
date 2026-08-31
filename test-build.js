const fs = require('fs');
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');

// Extract the escaped content
const openPos = 10729;
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}
const escaped = src.substring(openPos + 1, pos);

// UNESCAPE: reverse the escaping to get raw HTML
// \\ -> \  (but careful: need to handle escaped backslashes)
// \` -> `
// \${ -> ${
let raw = escaped
  .replace(/\\\\/g, '\x00BS\x00')
  .replace(/\\`/g, '`')
  .replace(/\\\$/g, '$')
  .replace(/\x00BS\x00/g, '\\');

// Fix: \${ was being matched as \\\$ which is wrong
// Let me redo this more carefully
// In the escaped content:
//   \\\` = escaped backtick (literal \`)
//   \\\${ = escaped ${ (literal \${)  -- wait, that doesn't seem right
//   \\ = escaped backslash (literal \)

// Actually looking at the data: the escaped content has \\\` for backtick and the patterns look like:
// \`/api\${path}?ws=\${wsParam}
// So: \` is escaped backtick, \${ is escaped dollar-brace

raw = escaped
  .replace(/\\`/g, '\x00BT\x00')
  .replace(/\\\$/g, '\x00DL\x00')
  .replace(/\\\\/g, '\x00BS\x00')
  .replace(/\x00BT\x00/g, '`')
  .replace(/\x00DL\x00/g, '${')
  .replace(/\x00BS\x00/g, '\\');

fs.writeFileSync('/tmp/tew/index.html', raw);
console.log('Raw HTML:', raw.length, 'bytes');
console.log('Has real backticks:', raw.includes('`'));
console.log('Has real ${:', raw.includes('${'));
