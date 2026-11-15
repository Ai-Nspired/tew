import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createJournal, metadataFor, SCHEMA } from './journal.js';

/** D1-shaped adapter over real SQLite, so the SQL is actually executed. */
function d1() {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      let params = [];
      return {
        bind(...args) {
          params = args;
          return this;
        },
        async run() {
          const r = statement.run(...params);
          return { changes: r.changes, meta: { last_row_id: Number(r.lastInsertRowid) } };
        },
        async first() {
          return statement.get(...params) || null;
        },
        async all() {
          return { results: statement.all(...params) };
        },
      };
    },
  };
}

function kv() {
  const map = new Map();
  const puts = [];
  return {
    puts,
    async put(key, value, opts = {}) {
      puts.push({ key, opts });
      map.set(key, { value, metadata: opts.metadata });
    },
    async get(key) {
      return map.has(key) ? map.get(key).value : null;
    },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...map.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, v]) => ({ name, metadata: v.metadata || null })),
      };
    },
  };
}

const fixed = () => new Date('2026-11-15T09:30:00.000Z');

async function build() {
  const store = kv();
  const journal = createJournal({ DB: d1(), KV: store }, { clock: fixed });
  await journal.ensure();
  return { journal, store };
}

test('the schema file and the schema the journal applies say the same thing', () => {
  const file = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of SCHEMA) {
    const table = statement.match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/)?.[1];
    assert.ok(table, `unreadable statement: ${statement}`);
    assert.match(file, new RegExp(`CREATE (?:TABLE|INDEX) IF NOT EXISTS ${table}\\b`), `${table} missing from schema.sql`);
  }
  for (const column of ['id', 'at', 'domain', 'asked', 'decided', 'correct', 'corrected_to']) {
    assert.match(file, new RegExp(`\\b${column}\\b`), `column ${column} missing from schema.sql`);
  }
});

test('an interaction writes the row, the body, and metadata — with no TTL anywhere', async () => {
  const { journal, store } = await build();
  const wrote = await journal.record({
    domain: 'legal',
    asked: 'make me an audit of the deed',
    decided: 'card:audit',
    answer: { intent: { type: 'choice', choice: 'audit', confidence: 0.91 } },
  });

  assert.ok(wrote.id > 0);
  assert.equal(wrote.key, 'int:legal:2026-11-15T09:30:00.000Z');

  const rows = await journal.recent({ domain: 'legal' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asked, 'make me an audit of the deed');
  assert.equal(rows[0].decided, 'card:audit');
  assert.equal(rows[0].correct, null, 'no verdict yet');

  const body = await journal.interaction(wrote.key);
  assert.equal(body.answer.intent.choice, 'audit');

  for (const put of store.puts) {
    assert.equal(put.opts.expirationTtl, undefined, `${put.key} was written with a TTL`);
    assert.ok(put.opts.metadata, `${put.key} was written without metadata`);
  }
});

test('his verdict lands in the row and in the metadata, still with no TTL', async () => {
  const { journal, store } = await build();
  const { id, key } = await journal.record({ domain: 'legal', asked: 'file the letter', decided: 'card:file' });

  await journal.judge({ id, correct: false, correctedTo: 'card:distill', result: 'filed the wrong document' });

  const [row] = await journal.recent({ domain: 'legal' });
  assert.equal(row.correct, 0);
  assert.equal(row.corrected_to, 'card:distill');

  const body = await journal.interaction(key);
  assert.equal(body.correct, 0);
  assert.equal(body.correctedTo, 'card:distill');
  assert.equal(body.result, 'filed the wrong document');

  const last = store.puts.at(-1);
  assert.equal(last.opts.expirationTtl, undefined);
  assert.equal(last.opts.metadata.correct, 0);
});

test('agreement comes from the rows: correct, wrong, and still-open', async () => {
  const { journal } = await build();
  const a = await journal.record({ domain: 'legal', asked: 'q1', decided: 'card:audit' });
  const b = await journal.record({ domain: 'legal', asked: 'q2', decided: 'card:file' });
  const c = await journal.record({ domain: 'legal', asked: 'q3', decided: 'card:merge' });
  await journal.record({ domain: 'medical', asked: 'q4', decided: 'card:audit' });

  await journal.judge({ id: a.id, correct: true });
  await journal.judge({ id: b.id, correct: true });
  await journal.judge({ id: c.id, correct: false, correctedTo: 'card:template' });

  const legal = await journal.agreement('legal');
  assert.equal(legal.correct, 2);
  assert.equal(legal.wrong, 1);
  assert.equal(legal.pending, 0);
  assert.equal(legal.rate, 0.6667);

  const everything = await journal.agreement();
  assert.equal(everything.pending, 1, 'the medical interaction has no verdict yet');
  assert.equal(everything.verdicts, 3);
});

test('notes are records too: no TTL, and they list with their metadata', async () => {
  const { journal, store } = await build();
  const written = await journal.note({ domain: 'legal', slug: 'deed-audit', text: 'the deed audit wants card:audit, never template' });

  assert.equal(written.key, 'note:legal:deed-audit');
  assert.equal(await journal.interaction('note:legal:deed-audit'), 'the deed audit wants card:audit, never template');

  const listed = await journal.notes({ domain: 'legal' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].metadata.domain, 'legal');

  for (const put of store.puts) assert.equal(put.opts.expirationTtl, undefined);

  // He can rewrite it by hand, and she reads the rewrite next pass.
  await journal.note({ domain: 'legal', slug: 'deed-audit', text: 'deed audit: card:audit, then card:file' });
  assert.equal(await journal.interaction('note:legal:deed-audit'), 'deed audit: card:audit, then card:file');
});

test('metadata stays inside what KV will accept, even for a huge ask', () => {
  const big = 'a'.repeat(5000);
  const meta = metadataFor({ at: '2026-11-15T09:30:00.000Z', domain: 'legal', asked: big, decided: 'card:audit', result: 'b'.repeat(5000) });
  assert.ok(JSON.stringify(meta).length <= 1024, `metadata was ${JSON.stringify(meta).length} bytes`);
  assert.equal(meta.domain, 'legal');
  assert.equal(meta.decided, 'card:audit');
});

test('a missing binding degrades instead of throwing', async () => {
  const store = kv();
  const kvOnly = createJournal({ KV: store }, { clock: fixed });
  const wrote = await kvOnly.record({ domain: 'legal', asked: 'no database here', decided: 'card:audit' });
  assert.equal(wrote.id, null);
  assert.ok(await kvOnly.interaction(wrote.key));
  assert.deepEqual(await kvOnly.recent(), []);

  const dbOnly = createJournal({ DB: d1() }, { clock: fixed });
  await dbOnly.ensure();
  const row = await dbOnly.record({ domain: 'legal', asked: 'no kv here', decided: 'card:audit' });
  assert.ok(row.id > 0);
  assert.equal((await dbOnly.recent()).length, 1);
});
