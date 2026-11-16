#!/usr/bin/env node
// Does the running Worker match this checkout? Push-to-main is supposed to deploy, but a
// build that never fires looks exactly like a build that succeeded: the old page keeps
// answering 200. Comparing the served inline script to the one this source emits catches
// that: the page is emitted from worker.js, so editing the UI changes the served bytes.
// It is a floor rather than proof - a server-only edit leaves the page identical.
//
//   node tools/deploy-check.mjs                     # against tew.ai-n.workers.dev
//   node tools/deploy-check.mjs https://host/       # another origin
//
// Exit 0 = live matches this source. 1 = live is behind (or ahead). 2 = could not tell.
// No dependencies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const origin = (process.argv[2] || 'https://tew.ai-n.workers.dev/').replace(/\/+$/, '') + '/';

function inlineScript(page) {
  const m = page.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}
function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

let localPage;
try {
  const source = readFileSync(resolve(root, 'worker.js'), 'utf8');
  const found = source.match(/var INDEX_HTML = `([\s\S]*?)`\n(?:var|const|function) /);
  if (!found) throw new Error('could not find `var INDEX_HTML = ` ... ` in worker.js');
  localPage = new Function('return `' + found[1] + '`;')();
} catch (err) {
  console.error('deploy-check: cannot read the local page (' + err.message + ')');
  process.exit(2);
}
const localScript = inlineScript(localPage);
if (!localScript) {
  console.error('deploy-check: the local page has no inline <script>');
  process.exit(2);
}

let livePage;
try {
  const res = await fetch(origin, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  livePage = await res.text();
} catch (err) {
  console.error('deploy-check: cannot reach ' + origin + ' (' + err.message + ')');
  process.exit(2);
}
const liveScript = inlineScript(livePage);
if (!liveScript) {
  console.error('deploy-check: the live page has no inline <script>');
  process.exit(2);
}

let head = 'unknown';
try { head = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch (e) {}

const localHash = hash(localScript);
const liveHash = hash(liveScript);

if (localHash === liveHash) {
  console.log('deploy-check: live matches this source (' + localHash + ', ' + localScript.length + ' bytes) at HEAD ' + head);
  process.exit(0);
}

console.error('deploy-check: the live Worker does not match this checkout.');
console.error('  local ' + localHash + ' (' + localScript.length + ' bytes) at HEAD ' + head);
console.error('  live  ' + liveHash + ' (' + liveScript.length + ' bytes) from ' + origin);
console.error('  A push that never built looks like this. Check the Workers Builds connection');
console.error('  for this Worker in the Cloudflare dashboard, or deploy with `npx wrangler deploy`.');
process.exit(1);
