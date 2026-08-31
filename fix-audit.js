const fs = require('fs');
let html = fs.readFileSync('/tmp/tew/index.html', 'utf8');

// Find the Audit card block and add toolbar + textarea
// The Audit block starts with: contentHtml = `\n          <div style="padding:4px 0;" class="audit-${card.status || 'fail'}">
const auditPattern = `contentHtml = \`\n          <div style="padding:4px 0;" class="audit-\${card.status || 'fail'}">\n            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">`;

const auditReplacement = `contentHtml = \`\n          <div style="padding:4px 0;" class="audit-\${card.status || 'fail'}">\n            <div class="card-toolbar" style="margin-bottom:0;">\n              <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>\n              <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>\n            </div>\n            \${fmtBar}\n            <textarea data-content="\${card.id}" placeholder="Audit notes…">\${escapeHtml(card.content || '')}</textarea>\n            <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>\n            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">`;

if (html.includes(auditPattern)) {
  html = html.replace(auditPattern, auditReplacement);
  console.log('Audit card fixed');
} else {
  console.log('Pattern not found, trying alternative...');
  // Try to find the Audit block
  const idx = html.indexOf('card.type === \'Audit\'');
  console.log('Audit block starts at:', idx);
  console.log('Content around it:', html.substring(idx, idx + 300));
}

fs.writeFileSync('/tmp/tew/index.html', html);
