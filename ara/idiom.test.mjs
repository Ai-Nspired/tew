import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, memoryStore, normalizeAsk } from './idiom.js';

const ask = 'make me an audit';

async function trained(times, move = 'card:audit') {
  const memory = createMemory(memoryStore());
  let state;
  for (let i = 0; i < times; i++) state = await memory.remember(ask, move);
  return { memory, state };
}

test('the same ask reduces to the same key', () => {
  assert.equal(normalizeAsk('  Make me an AUDIT. '), normalizeAsk('make me an audit'));
  assert.notEqual(normalizeAsk('make me an audit'), normalizeAsk('make me a template'));
});

test('his first choice is a baseline, not agreement with herself', async () => {
  const memory = createMemory(memoryStore());
  const first = await memory.remember(ask, 'card:audit');
  assert.equal(first.agree, 0);
  assert.equal(first.disagree, 0);
  assert.equal(first.consistency, null);
  assert.equal(first.canWork, false);
});

test('three choices that match his are 100% consistency, and she works without asking', async () => {
  // His first choice is the baseline, so this is the baseline plus three that match it.
  const { memory, state } = await trained(4);
  assert.equal(state.agree, 3);
  assert.equal(state.consistency, 1);
  assert.equal(state.canWork, true);
  assert.equal(await memory.recall(ask), 'card:audit');
});

test('two out of three is 67%, under the mark, so she still asks', async () => {
  const memory = createMemory(memoryStore());
  await memory.remember(ask, 'card:audit');
  await memory.remember(ask, 'card:audit');
  await memory.remember(ask, 'card:audit');
  const state = await memory.remember(ask, 'card:template');
  assert.equal(state.agree, 2);
  assert.equal(state.disagree, 1);
  assert.equal(state.consistency, 0.6667);
  assert.equal(state.canWork, false);
  assert.equal(await memory.recall(ask), null);
});

test('three out of four is 75%, over the mark, and she is allowed to move', async () => {
  const memory = createMemory(memoryStore());
  await memory.remember(ask, 'card:audit');
  await memory.remember(ask, 'card:audit');
  await memory.remember(ask, 'card:audit');
  await memory.remember(ask, 'card:audit');
  const state = await memory.remember(ask, 'card:template');
  assert.equal(state.agree, 3);
  assert.equal(state.disagree, 1);
  assert.equal(state.consistency, 0.75);
  assert.equal(state.canWork, true);
  assert.equal(await memory.recall(ask), 'card:template', 'she moved to the move he corrected her to');
});

test('a correction is counted, not quietly absorbed', async () => {
  const memory = createMemory(memoryStore());
  await memory.remember(ask, 'card:audit');
  await memory.remember(ask, 'card:audit');
  const corrected = await memory.remember(ask, 'card:distill');
  assert.equal(corrected.move, 'card:distill');
  assert.equal(corrected.agree, 1);
  assert.equal(corrected.disagree, 1);
  assert.equal(corrected.consistency, 0.5);
  assert.equal(corrected.canWork, false);
});

test('a high mark still needs enough of his choices behind it', async () => {
  const memory = createMemory(memoryStore());
  await memory.remember(ask, 'card:audit');
  const once = await memory.remember(ask, 'card:audit');
  assert.equal(once.consistency, 1);
  assert.equal(once.choices, 1);
  assert.equal(once.canWork, false, 'one perfect choice is not a track record');
});

test('she can forget, and she can show what she has learned', async () => {
  const memory = createMemory(memoryStore());
  await memory.remember(ask, 'card:audit');
  await memory.remember('file it', 'card:file');
  await memory.remember('file it', 'card:file');
  assert.equal((await memory.all()).length, 2);

  await memory.forget(ask);
  assert.equal(await memory.recall(ask), null);
  assert.equal((await memory.all()).length, 1);
});
