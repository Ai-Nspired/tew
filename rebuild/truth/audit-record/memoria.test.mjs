import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

// KV stand-in with the two things the memoria code relies on: list() that can
// truncate with a cursor, and put() that records its options so a TTL cannot
// slip back in unnoticed.
function kv(seed = {}) {
  const m = new Map(Object.entries(seed));
  const puts = [];
  return {
    puts,
    map: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, opts) { puts.push({ key: k, opts: opts || null }); m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      const slice = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { keys: slice.map((name) => ({ name })), truncated, cursor: truncated ? slice[slice.length - 1] : undefined };
    }
  };
}

const call = (path, init = {}, env = {}) => worker.fetch(new Request(`https://truth${path}`, init), env);
const post = (path, body, env) => call(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
}, env);

test("intake writes a memory truth and gives it no clock", async () => {
  const env = { PROV_TRUTH: kv() };
  const res = await post("/api/truth/memory/intake", {
    query: "Does a motion to dismiss need a certificate of conferral",
    answer: "Under Rule 37(a)(1) a motion to compel discovery must include a certification that the movant conferred in good faith.",
    source: "audit", model: "test"
  }, env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.created, true);
  assert.equal(out.indexed, true);
  const memoryPuts = env.PROV_TRUTH.puts.filter((p) => p.key.startsWith("truth:"));
  assert.equal(memoryPuts.length, 1);
  assert.equal(memoryPuts[0].opts, null, "a memory truth is stored with no expirationTtl");
  const indexRaw = env.PROV_TRUTH.map.get("memoria:index");
  assert.ok(indexRaw, "the index exists after the first intake");
  assert.ok(JSON.parse(indexRaw).entries[out.id].w.includes("conferral"));
});

test("the same question updates one row instead of piling up", async () => {
  const env = { PROV_TRUTH: kv() };
  const body = { query: "Notice of appeal deadline", answer: "A notice of appeal is due within 30 days of entry of judgment." };
  await post("/api/truth/memory/intake", body, env);
  const second = await (await post("/api/truth/memory/intake", { ...body, answer: "Thirty days from entry, extended to 60 if the United States is a party." }, env)).json();
  assert.equal(second.created, false);
  assert.equal(second.count, 1);
});

test("a stub answer is refused", async () => {
  const res = await post("/api/truth/memory/intake", { query: "x", answer: "too short" }, { PROV_TRUTH: kv() });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "answer_too_short");
});

test("reindex walks a bounded batch and hands back a cursor", async () => {
  const rows = {};
  for (const [id, q] of [["alpha-motion", "motion to dismiss"], ["beta-order", "order granting leave"], ["gamma-answer", "answer to complaint"]]) {
    rows["truth:" + id] = JSON.stringify({ id, query: q, answer: "A long enough stored answer for " + id, updated: 1 });
  }
  const env = { PROV_TRUTH: kv(rows) };
  const first = await (await post("/api/truth/memory/reindex", { limit: 2, reset: true }, env)).json();
  assert.equal(first.done, false);
  assert.ok(first.cursor, "a truncated page hands back a cursor");
  assert.equal(first.count, 2);
  const second = await (await post("/api/truth/memory/reindex", { limit: 2, cursor: first.cursor }, env)).json();
  assert.equal(second.done, true);
  assert.equal(second.count, 3);
});

test("resolve answers from memory by text, without generating", async () => {
  const prov = kv();
  await post("/api/truth/memory/intake", {
    query: "Does a motion to compel need a certificate of conferral",
    answer: "Rule 37(a)(1) requires the movant to certify that it conferred in good faith before filing.",
    source: "audit"
  }, { PROV_TRUTH: prov });

  let generated = 0;
  const env = {
    PROV_TRUTH: prov,
    MASTER_TRUTHS: kv(),
    OP: { async fetch() { generated++; return new Response(JSON.stringify({ answer: "generated" }), { status: 200 }); } }
  };
  const res = await post("/api/truth/resolve", {
    input: "certificate of conferral motion to compel discovery"
  }, env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.source, "audit");
  assert.equal(out.layer, "provisional");
  assert.match(out.answer, /Rule 37\(a\)\(1\)/);
  assert.equal(generated, 0, "a memory hit must not spend a generation");
});

test("an unrelated question does not borrow a memory row", async () => {
  const prov = kv();
  await post("/api/truth/memory/intake", {
    query: "Does a motion to compel need a certificate of conferral",
    answer: "Rule 37(a)(1) requires a certification of good-faith conferral before filing.",
    source: "audit"
  }, { PROV_TRUTH: prov });
  const env = {
    PROV_TRUTH: prov,
    MASTER_TRUTHS: kv(),
    OP: { async fetch() { throw new Error("no generation in this test"); } }
  };
  const res = await post("/api/truth/resolve", { input: "weather forecast for tuesday" }, env);
  const out = await res.json().catch(() => ({}));
  assert.notEqual(out.source, "audit", "an unrelated query must not match a stored memory truth");
});
