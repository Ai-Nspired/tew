#!/usr/bin/env node
// The whole workspace UI lives inside `var INDEX_HTML = \`...\`` in worker.js, so the
// page the Worker serves is *emitted* text, not the source. An escaping fault such as
// /^https?:\/\//i written in the source arrives as /^https?://i — the second // opens
// a comment, the line is swallowed, and the inline script fails to parse. The server
// never notices: it still serves 200 and a shell of HTML, with every handler gone.
//
// `node --check worker.js` cannot see this, because the source itself is valid JS.
// This emits the page the way the Worker does and parses its inline script.
//
//   node tools/check-page.mjs            # checks ./worker.js
//   node tools/check-page.mjs path/to/worker.js
//
// No dependencies. Exit 0 = the served page's script parses.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..', 'worker.js');

function die(message) {
  console.error('check-page: ' + message);
  process.exit(1);
}

let source;
try {
  source = readFileSync(target, 'utf8');
} catch (err) {
  die('cannot read ' + target + ' (' + err.message + ')');
}

// The literal ends where the file says `\nvar server_default` — matching the end of
// the template is easier to trust than counting escapes.
const found = source.match(/var INDEX_HTML = `([\s\S]*?)`\n(?:var|const|function) /);
if (!found) die('could not find `var INDEX_HTML = ` ... ` in ' + target);

let page;
try {
  page = new Function('return `' + found[1] + '`;')();
} catch (err) {
  die('the page template only evaluates with runtime values ("' + err.message + '"); check it through `wrangler dev` instead');
}

const script = page.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!script) die('the emitted page has no inline <script>');

try {
  new vm.Script(script[1], { filename: 'served-inline.js' });
} catch (err) {
  const line = err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : String(err);
  console.error('check-page: the served page\'s inline script does not parse.');
  console.error('  This is emitted text — fix the escaping in the source of INDEX_HTML.\n');
  console.error(line);
  process.exit(1);
}

console.log('check-page: served inline script parses (' + script[1].length + ' bytes)');
