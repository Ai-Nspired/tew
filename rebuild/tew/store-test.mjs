import { VERSION, serialise, deserialise, recordEdit, memoryStore, browserStore, kvStore, r2Store, doStore, moveCards, offerMembership } from "./store.mjs";

let pass = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (detail === undefined ? "" : " -> " + JSON.stringify(detail))); }
}

const card = (n) => ({ id: "c" + n, q: "question " + n, a: "answer " + n });
const many = Array.from({ length: 200 }, (_, i) => card(i));

// --- the shape travels --------------------------------------------------------

const tag = serialise(many);
check("the set is versioned", tag.v === VERSION, tag.v);
check("200 cards survive a round trip", deserialise(JSON.stringify(tag)).length === 200, null);
check("nothing is capped on the way through", deserialise(JSON.stringify(serialise(many))).length === many.length, null);
check("junk reads back as nothing", deserialise("{not json").length === 0, null);
check("a bare array is not a set", deserialise("[1,2,3]").length === 0, null);

// --- an edit is a trail -------------------------------------------------------

let c = recordEdit(card(1), { field: "a", from: "answer 1", to: "the answer, corrected", by: "owner", at: "2026-11-14T10:00:00Z" });
check("the edit keeps both values", c.edits[0].from === "answer 1" && c.edits[0].to === "the answer, corrected", c.edits);
check("the edit records who and when", c.edits[0].by === "owner" && c.edits[0].at === "2026-11-14T10:00:00Z", c.edits);
check("the card is marked edited", c.edited === true && c.edited_at === "2026-11-14T10:00:00Z", c);
check("the original card is untouched", card(1).edits === undefined, null);
c = recordEdit(c, { field: "q", from: "question 1", to: "what happened", by: null, at: "2026-11-14T10:05:00Z" });
check("a second edit appends", c.edits.length === 2 && c.edits[1].field === "q", c.edits);

// --- one set, five stores -----------------------------------------------------

const mem = memoryStore();
check("memory saves and loads", (await mem.save(many)).ok && (await mem.load()).length === 200, null);

const fakeStorage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), size: () => m.size }; })();
const browser = browserStore(fakeStorage, "tew");
const bw = await browser.save(many, { by: "owner" });
check("the browser store keeps all 200", bw.ok && (await browser.load()).length === 200, bw);
check("the browser store reports its size", bw.bytes > 0, bw.bytes);
check("the browser store names its key", fakeStorage.size() === 1, fakeStorage.size());

const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
const tight = await browserStore(full, "tew").save(many);
check("a full store says so instead of dropping cards", tight.ok === false && tight.error === "store_full" && tight.count === 200, tight);

const kvMap = new Map();
const kv = { get: async (k) => kvMap.get(k) ?? null, put: async (k, v) => { kvMap.set(k, v); } };
const kvs = kvStore(kv, "tew");
check("kv saves and loads the set", (await kvs.save(many)).ok && (await kvs.load()).length === 200, null);
check("kv holds it under one key", [...kvMap.keys()].join() === "cards:tew", [...kvMap.keys()]);

const r2Map = new Map();
const bucket = {
  get: async (k) => (r2Map.has(k) ? { text: async () => r2Map.get(k) } : null),
  put: async (k, v) => { r2Map.set(k, v); }
};
const r2 = r2Store(bucket, "tew");
check("r2 saves and loads the set", (await r2.save(many)).ok && (await r2.load()).length === 200, null);
check("r2 stores json with a type", [...r2Map.keys()].join() === "cards:tew.json", [...r2Map.keys()]);

let held = null;
const stub = {
  fetch: async (url, init) => {
    if (init && init.method === "PUT") { held = init.body; return new Response("{}", { status: 200 }); }
    return new Response(held || "", { status: 200 });
  }
};
const dstore = doStore(stub, { path: "/state" });
check("the durable object saves and loads the set", (await dstore.save(many)).ok && (await dstore.load()).length === 200, null);
check("the durable object uses the path it was given", held && held.includes("question 0"), null);

// --- moving a set -------------------------------------------------------------

const from = memoryStore(many);
const to = memoryStore();
const moved = await moveCards(from, to, { by: "owner" });
check("a set moves between stores whole", moved.ok && moved.moved === 200, moved);
const brokenTo = { name: "broken", load: async () => [], save: async () => ({ ok: true }) };
const bad = await moveCards(from, brokenTo, {});
check("a store that loses cards is caught, not trusted", bad.ok === false && bad.error === "count_mismatch", bad);

// --- what a store promises, and when that is worth asking about ---------------

check("the browser is a guest's device, not a keeper", browserStore(fakeStorage, "t").durable === false && browserStore(fakeStorage, "t").member === false, null);
check("kv is a keeper", kvStore(kv, "t").durable === true && kvStore(kv, "t").member === true, null);
check("r2 is a keeper", r2Store(bucket, "t").durable === true, null);
check("the durable object is a keeper", doStore(stub).durable === true, null);

check("an empty set earns no ask", offerMembership({ cards: [] }) === null, null);
check("a set nobody has touched earns no ask", offerMembership({ cards: many, saved: { ok: true } }) === null, null);
check("a device that cannot hold the set earns the ask",
  (offerMembership({ cards: many, saved: tight }) || {}).reason === "device_full", offerMembership({ cards: many, saved: tight }));
check("the ask carries the size, so it can be specific",
  (offerMembership({ cards: many, saved: tight }) || {}).bytes > 0, null);
check("a set the user has corrected earns the ask",
  (offerMembership({ cards: many, edits: 3 }) || {}).reason === "set_is_yours", null);
check("the ask says it needs a member", (offerMembership({ cards: many, edits: 1 }) || {}).needs_member === true, null);

console.log("\n" + pass + " passed, " + failed + " failed");
if (failed) process.exit(1);
