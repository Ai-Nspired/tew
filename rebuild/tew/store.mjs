// A card set is a card set wherever it lives: the browser, the Workspace
// Durable Object, KV, R2, or someone's own storage after a login. The same
// serialised shape goes in and comes out, so a set can move between them without
// anything above this knowing where it came from.
//
// No cap lives here. The only limit that existed was slice(0, 80) against
// localStorage, which is a property of one store, not of a card.

export const VERSION = 1;

export function serialise(cards, meta = {}) {
  return {
    v: VERSION,
    at: meta.at || null,
    by: meta.by || null,
    cards: Array.isArray(cards) ? cards : []
  };
}

export function deserialise(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.cards)) return [];
  return data.cards;
}

// What changed on a card, kept as a trail rather than a summary sentence: the
// field, the two values, who did it and when. A summary can be read once; a trail
// can be read by anything.
export function recordEdit(card, change) {
  const edits = Array.isArray(card.edits) ? card.edits.slice() : [];
  const entry = {
    at: change.at || null,
    field: change.field,
    from: change.from === undefined ? null : change.from,
    to: change.to === undefined ? null : change.to,
    by: change.by === undefined ? null : change.by
  };
  edits.push(entry);
  return Object.assign({}, card, { edits, edited_at: entry.at, edited: true });
}

const KEY = (scope) => "cards:" + (scope || "default");

// What a store can promise. A guest's set lives on their device and can go when
// the browser does; a member's set is kept. The app does not need to know which
// store it is holding to say what is at risk.
export const PROMISE = {
  memory: { durable: false, member: false, device: false },
  browser: { durable: false, member: false, device: true },
  kv: { durable: true, member: true, device: false },
  r2: { durable: true, member: true, device: false },
  do: { durable: true, member: true, device: false }
};

// --- stores -----------------------------------------------------------------
// Every store has the same two methods. Nothing above chooses a store.

export function memoryStore(initial) {
  let held = serialise(initial === undefined ? [] : initial);
  return {
    name: "memory",
    ...PROMISE.memory,
    async load() {
      return deserialise(held);
    },
    async save(cards, meta) {
      held = serialise(cards, meta);
      return { ok: true, count: held.cards.length };
    }
  };
}

// The browser. storage is localStorage, or sessionStorage, or anything with
// getItem/setItem/removeItem. A set that will not fit is a quota problem to
// surface, not a reason to drop cards silently.
export function browserStore(storage, scope) {
  const key = KEY(scope);
  return {
    name: "browser",
    ...PROMISE.browser,
    async load() {
      const raw = storage && storage.getItem ? storage.getItem(key) : null;
      return deserialise(raw);
    },
    async save(cards, meta) {
      const body = JSON.stringify(serialise(cards, meta));
      try {
        storage.setItem(key, body);
        return { ok: true, count: cards.length, bytes: body.length };
      } catch (e) {
        return { ok: false, error: "store_full", message: String(e && e.message), count: cards.length, bytes: body.length };
      }
    }
  };
}

// KV_NAMESPACES in TEW. One key holds the set.
export function kvStore(kv, scope) {
  const key = KEY(scope);
  return {
    name: "kv",
    ...PROMISE.kv,
    async load() {
      if (!kv) return [];
      return deserialise(await kv.get(key));
    },
    async save(cards, meta) {
      if (!kv) return { ok: false, error: "no_binding" };
      await kv.put(key, JSON.stringify(serialise(cards, meta)));
      return { ok: true, count: cards.length };
    }
  };
}

// The R2 bucket. The set is one object; split it per card if a set outgrows a
// single put.
export function r2Store(bucket, scope) {
  const key = KEY(scope) + ".json";
  return {
    name: "r2",
    ...PROMISE.r2,
    async load() {
      if (!bucket) return [];
      const obj = await bucket.get(key);
      return obj ? deserialise(await obj.text()) : [];
    },
    async save(cards, meta) {
      if (!bucket) return { ok: false, error: "no_binding" };
      await bucket.put(key, JSON.stringify(serialise(cards, meta)), {
        httpMetadata: { contentType: "application/json" }
      });
      return { ok: true, count: cards.length };
    }
  };
}

// The Workspace Durable Object. `path` is whatever route the DO serves the state
// on; set it from the DO, not from here.
export function doStore(stub, options = {}) {
  const path = options.path || "/state";
  return {
    name: "do",
    ...PROMISE.do,
    async load() {
      if (!stub) return [];
      const res = await stub.fetch("https://workspace" + path);
      if (!res.ok) return [];
      return deserialise(await res.text());
    },
    async save(cards, meta) {
      if (!stub) return { ok: false, error: "no_binding" };
      const res = await stub.fetch("https://workspace" + path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(serialise(cards, meta))
      });
      return { ok: res.ok, count: cards.length, status: res.status };
    }
  };
}

// When to ask. Not on arrival: the set has to be worth keeping first, either
// because it has been corrected, or because the device will not hold it.
export function offerMembership({ cards = [], saved = null, edits = 0 } = {}) {
  if (saved && saved.ok === false && saved.error === "store_full") {
    return { reason: "device_full", needs_member: true, cards: cards.length, bytes: saved.bytes || null };
  }
  if (edits > 0) {
    return { reason: "set_is_yours", needs_member: true, cards: cards.length, edits };
  }
  if (!cards.length) return null;
  return null;
}

// Move a set from wherever it is to wherever it should be, and prove it arrived
// whole before anything is deleted from the old place.
export async function moveCards(from, to, meta) {
  const before = await from.load();
  const written = await to.save(before, meta);
  if (!written.ok) return { ok: false, error: written.error, moved: 0 };
  const after = await to.load();
  if (after.length !== before.length) {
    return { ok: false, error: "count_mismatch", moved: 0, before: before.length, after: after.length };
  }
  return { ok: true, moved: after.length };
}
