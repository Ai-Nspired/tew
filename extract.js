const fs = require('fs');
const src = fs.readFileSync('/tmp/tew/worker.js', 'utf8');

// Find INDEX_HTML template literal boundaries
const startMarker = 'var INDEX_HTML = `';
const idx = src.indexOf(startMarker);
const openPos = src.indexOf('`', idx);

// Find matching close backtick
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}

// The content between backticks is an escaped JS string
// Use JS itself to unescape it by wrapping in a template literal
const escapedContent = src.substring(openPos + 1, pos);

// Build a temp JS file that evaluates the template literal content
// We need to construct a valid JS expression that produces the raw string
// The escaped content has: \\ -> \, \` -> `, \${ -> ${
// We can use a function to unescape it

// Method: replace the escaped sequences manually
let raw = escapedContent
  // First handle triple backslash + backtick: \\\` -> \` (literal backslash + backtick)
  // Actually, the proper way: JS template literal evaluation
  // \\ -> \
  // \` -> `
  // \$ -> $
  // So: \\\` = \\ + \` = \ + ` = \` (backslash + backtick)
  // And: \\\${ = \\ + \$ + { = \ + $ + { = \${ (backslash + dollar + brace)
  // But wait - this means the raw HTML contains backslash before backtick/backtick before dollar
  // which is WRONG. The raw HTML should have just ` and ${
  
  // Actually, let me just use the approach of constructing a JS string
  // that evaluates correctly
  ;

// Better approach: construct a JS string literal from the escaped content
// and let JS evaluate it
// The escaped content is what would be inside a template literal
// So we can wrap it in backticks and evaluate

// But some content might have `\`` which would break our wrapping
// Let's use a different approach: build a string by processing escape sequences

let result = '';
for (let i = 0; i < escapedContent.length; i++) {
  if (escapedContent[i] === '\\') {
    const next = escapedContent[i + 1];
    if (next === '\\') { result += '\\'; i++; }
    else if (next === '`') { result += '`'; i++; }
    else if (next === '$') { result += '$'; i++; }
    else if (next === 'n') { result += '\n'; i++; }
    else if (next === 't') { result += '\t'; i++; }
    else if (next === 'r') { result += '\r'; i++; }
    else { result += escapedContent[i]; }
  } else {
    result += escapedContent[i];
  }
}

fs.writeFileSync('/tmp/tew/index.html', result);
console.log('Raw HTML:', result.length, 'bytes');

// Verify: check for \${ and \` patterns (should be 0)
const badDollar = (result.match(/\\\${/g) || []).length;
const badBacktick = (result.match(/\\`/g) || []).length;
console.log('Remaining \\${ patterns:', badDollar);
console.log('Remaining \\` patterns:', badBacktick);
console.log('Has real ${:', result.includes('${'));
console.log('Has real backticks:', result.includes('`'));
