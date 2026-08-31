const fs = require('fs');
let html = fs.readFileSync('/tmp/tew/index.html', 'utf8');

// 1. Add edit/preview toolbar + fmtBar + textarea to Instruct
const instructOld = `contentHtml = \`
          <div style="padding:4px 0;">
            <div style="margin-bottom:6px;padding:6px 8px;background:#111122;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;color:#888;">`;
const instructNew = `contentHtml = \`
          <div style="padding:4px 0;">
            <div class="card-toolbar" style="margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('${'$'}{card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('${'$'}{card.id}','preview')">Preview</button>
            </div>
            ${'$'}fmtBar
            <textarea data-content="${'$'}{card.id}" placeholder="Enter instruction...\\n\\nThe ambient LLM will route this through the active principle stack. Output is domain-bound before it exists.">${'$'}escapeHtml(card.content || '')</textarea>
            <div class="md-preview" data-preview="${'$'}{card.id}" style="display:none;"></div>
            <div style="margin-bottom:6px;padding:6px 8px;background:#111122;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;color:#888;">`;
html = html.replace(instructOld, instructNew);

// 2. Add edit/preview toolbar + fmtBar + textarea to Query
const queryOld = `contentHtml = \`
          <div style="padding:4px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
              <span style="font-size:10px;color:#888;">Domain:</span>`;
const queryNew = `contentHtml = \`
          <div style="padding:4px 0;">
            <div class="card-toolbar" style="margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('${'$'}{card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('${'$'}{card.id}','preview')">Preview</button>
            </div>
            ${'$'}fmtBar
            <textarea data-content="${'$'}{card.id}" placeholder="Query notes…">${'$'}escapeHtml(card.content || '')</textarea>
            <div class="md-preview" data-preview="${'$'}{card.id}" style="display:none;"></div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
              <span style="font-size:10px;color:#888;">Domain:</span>`;
html = html.replace(queryOld, queryNew);

// 3. Add edit/preview toolbar + fmtBar + textarea to Audit
const auditOld = `contentHtml = \`
          <div style="padding:4px 0;" class="audit-\${card.status || 'fail'}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-size:12px;font-weight:700;color:\${card.status || 'fail'}`;
const auditNew = `contentHtml = \`
          <div style="padding:4px 0;" class="audit-\${card.status || 'fail'}">
            <div class="card-toolbar" style="margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('${'$'}{card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('${'$'}{card.id}','preview')">Preview</button>
            </div>
            ${'$'}fmtBar
            <textarea data-content="${'$'}{card.id}" placeholder="Audit notes…">${'$'}escapeHtml(card.content || '')</textarea>
            <div class="md-preview" data-preview="${'$'}{card.id}" style="display:none;"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-size:12px;font-weight:700;color:\${card.status || 'fail'}`;
html = html.replace(auditOld, auditNew);

fs.writeFileSync('/tmp/tew/index.html', html);
console.log('Edits applied');

// Verify
console.log('Has toolbar edits:', (html.match(/card-toolbar/g) || []).length, 'toolbar refs');
console.log('Has fmtBar refs:', (html.match(/\${fmtBar}/g) || []).length, 'fmtBar refs');
console.log('Has toggleCardMode in cards:', (html.match(/toggleCardMode.*'edit'/g) || []).length, 'edit toggles');
