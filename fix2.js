const fs = require('fs');
let html = fs.readFileSync('/tmp/tew/index.html', 'utf8');

// Fix ${escapeHtml}(card.content || '') -> ${escapeHtml(card.content || '')}
html = html.replace(/\$\{escapeHtml\}\(card\.content \|\| ''\)/g, '${escapeHtml(card.content || \'\')}');
// Fix ${escapeHtml}(card.content) -> ${escapeHtml(card.content)}
html = html.replace(/\$\{escapeHtml\}\(card\.content\)/g, '${escapeHtml(card.content)}');

fs.writeFileSync('/tmp/tew/index.html', html);
console.log('Fixed');

// Verify
const matches = html.match(/\$\{escapeHtml\([^)]+\)\}/g);
console.log('escapeHtml patterns:', matches ? matches.length : 0);
matches?.forEach(m => console.log(' ', m));
