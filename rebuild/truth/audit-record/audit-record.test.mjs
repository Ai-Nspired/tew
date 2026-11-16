import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

// In-memory stand-in for the R2 binding (TBACKED) with the two methods the
// audit routes use: put() and get() returning a body with text()/json().
function bucket() {
  const store = new Map();
  return {
    store,
    async put(key, value) { store.set(key, String(value)); },
    async get(key) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return { key, text: async () => raw, json: async () => JSON.parse(raw) };
    },
    async delete(key) { store.delete(key); },
  };
}

const call = (path, init = {}, env = {}) =>
  worker.fetch(new Request(`https://truth${path}`, init), env);

const post = (body, env, headers = {}) =>
  call("/api/truth/audit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }, env);

test("saves an audit under the id the chain will use", async () => {
  const env = { TBACKED: bucket() };
  const res = await post({ id: "ab12cd", type: "docket", content: "Motion to dismiss", scores: { e: 7, m: 6, c: 8, total: 21 } }, env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.success, true);
  assert.equal(out.id, "ab12cd");
  assert.equal(out.stored, true);
  assert.ok(env.TBACKED.store.has("audits/ab12cd.json"));
});

test("mints an id when the caller sends none", async () => {
  const env = { TBACKED: bucket() };
  const out = await (await post({ content: "Order granting leave" }, env)).json();
  assert.match(out.id, /^[0-9a-f-]{36}$/);
  assert.ok(env.TBACKED.store.has(`audits/${out.id}.json`));
});

test("reads the record back by id", async () => {
  const env = { TBACKED: bucket() };
  await post({ id: "rec1", content: "Answer to complaint", domain: "civil", created_at: "2026-11-13T00:00:00.000Z" }, env);
  const res = await call("/api/truth/audit/rec1", {}, env);
  assert.equal(res.status, 200);
  const { audit: record } = await res.json();
  assert.equal(record.content, "Answer to complaint");
  assert.equal(record.domain, "civil");
  assert.equal(record.created_at, "2026-11-13T00:00:00.000Z");
  assert.equal(record.spec_version, "v1");
});

test("unknown id is a clean miss, not a crash", async () => {
  const res = await call("/api/truth/audit/never-saved", {}, { TBACKED: bucket() });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "audit_not_found");
});

test("rejects an id that could escape the key prefix", async () => {
  const env = { TBACKED: bucket() };
  assert.equal((await call("/api/truth/audit/..%2Fadmin-curated%2Fx", {}, env)).status, 400);
  assert.equal((await post({ id: "../x", content: "y" }, env)).status, 400);
  assert.equal(env.TBACKED.store.size, 0);
});

test("needs content, and says so", async () => {
  const env = { TBACKED: bucket() };
  const res = await post({ id: "empty", content: "   " }, env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "content_required");
  assert.equal(env.TBACKED.store.size, 0);
});

test("writes are gated by ADMIN_KEY once it is set", async () => {
  const env = { TBACKED: bucket(), ADMIN_KEY: "k3y" };
  const denied = await post({ content: "Motion" }, env);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, "admin_key_required");

  const allowed = await post({ id: "gated", content: "Motion" }, env, { "x-admin-key": "k3y" });
  assert.equal(allowed.status, 200);
  assert.ok(env.TBACKED.store.has("audits/gated.json"));

  const wrong = await post({ content: "Motion" }, env, { "x-admin-key": "nope" });
  assert.equal(wrong.status, 401);
});

test("the read stays public when ADMIN_KEY is set", async () => {
  const env = { TBACKED: bucket(), ADMIN_KEY: "k3y" };
  await post({ id: "pub1", content: "Notice of appeal" }, env, { "x-admin-key": "k3y" });
  const res = await call("/api/truth/audit/pub1", {}, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).audit.content, "Notice of appeal");
});

test("an unbound bucket is reported, not disguised", async () => {
  const env = {};
  assert.equal((await post({ content: "Motion" }, env)).status, 503);
  assert.equal((await call("/api/truth/audit/anything", {}, env)).status, 503);
});

test("keeps the audit text the page sends, not just the query", async () => {
  const env = { TBACKED: bucket() };
  const res = await post({
    content: "Motion to compel discovery",
    fullText: "The motion omits a certificate of conferral under Rule 37(a)(1).",
    messages: [{ role: "user", content: "Motion to compel discovery" }],
    type: "docket",
    audit_id: "audit-1",
  }, env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.audit_id, "audit-1");
  const { audit: record } = await (await call("/api/truth/audit/audit-1", {}, env)).json();
  assert.equal(record.full_text, "The motion omits a certificate of conferral under Rule 37(a)(1).");
  assert.equal(record.messages.length, 1);
  assert.equal(record.type, "docket");
  assert.equal(record.saved_count, 1);
});

test("a second save updates the record instead of erasing it", async () => {
  const env = { TBACKED: bucket() };
  await post({ content: "Response to motion", fullText: "first pass", audit_id: "audit-2" }, env);
  const res = await post({ audit_id: "audit-2", fullText: "second pass, with the citations checked" }, env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.created, false);
  const { audit: record } = await (await call("/api/truth/audit/audit-2", {}, env)).json();
  assert.equal(record.full_text, "second pass, with the citations checked");
  assert.equal(record.content, "Response to motion", "content survives a save that omits it");
  assert.equal(record.saved_count, 2);
});
