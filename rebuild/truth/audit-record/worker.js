// src/worker.js
// Truth Orchestrator (truth)
// Behaviors:
// 1) getProvisional checks both "provisional:<id>" (new) and "truth:provisional:<id>" (legacy).
// 2) /api/truth/provisional/update is create-or-update:
//    - If provisional exists: update it.
//    - If not: create it as a provisional.
// 3) Proxy candidate flow uses strict JSON-array instruction.

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// CORS
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-key",
  "Content-Type": "application/json"
};

// Constants
var KV_PREFIX_MASTER = "master:";
var KV_PREFIX_PROV = "provisional:";
// Memory rows live beside provisionals as "truth:<id>". 1150 of them existed and
// only an exact id ever reached one. The index makes them searchable, and it is
// data, not a cache: nothing here expires.
var MEMORIA_PREFIX = "truth:";
var MEMORIA_INDEX_KEY = "memoria:index";
var MEMORIA_MIN_SCORE = 0.5;
// Nothing in this store expires. Curated truths, memory rows and engine-written
// candidates all stay until a person deletes them, and R2 keeps a second copy of
// every save. A day-long clock here was silently destroying saved work.
// Name this for what it holds: the records saved by hand in the admin console.
// Only updateProvisional (the admin save path) writes here.
var ARCHIVE_PREFIX = "admin-curated/";

// AUDIT RECORD: the id the rest of the chain points at. An audit is worth
// nothing if nothing holds it — counsel receives ?audit=<id>, and the page at
// i.nspired.cc/a/<id> reads the same id back. One JSON object per audit in R2
// (bucket ai-nspired). KV stays what it is: the engine's answers.
var AUDIT_PREFIX = "audits/";
var AUDIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Filler words must not count as evidence: without this, "what is X" matches
// every row containing "the" or "what".
var CURATED_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "what", "who", "whom",
  "whose", "how", "why", "when", "where", "this", "that", "these",
  "those", "with", "from", "you", "your", "about", "tell", "give",
  "can", "does", "did", "not", "but", "into", "over", "under", "than",
  "then", "them", "they", "have", "has", "had", "will", "would",
  "should", "could", "please", "explain", "describe", "known"
]);
var SPEC_VERSION = "v1";

// normalizeId (unchanged)
function normalizeId(input) {
  if (!input || typeof input !== "string") return "unknown-query";
  let q = input
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
  const stemRules = {
    "\\brun(?:ning|s|n)?\\b": "run",
    "\\bprogram(?:ming|med)?\\b": "program",
    "\\bcode(?:d|ing)?\\b": "code",
    "\\bdevelop(?:ing|ed|ment)?\\b": "develop",
    "\\boptimiz(?:e|ation|ing|ed)?\\b": "optimize",
    "\\bcreat(?:e|ing|ed|ion)?\\b": "create",
    "\\bdebug(?:ging|ged)?\\b": "debug"
  };
  for (const pattern in stemRules) {
    const re = new RegExp(pattern, "gi");
    q = q.replace(re, stemRules[pattern]);
  }
  q = q.replace(/\s+/g, "-").substring(0, 100);
  if (q.length > 50) {
    const enc = new TextEncoder().encode(input);
    let hash = 0;
    for (const b of enc) {
      hash = ((hash << 5) - hash + b) | 0;
    }
    const short = (hash >>> 0).toString(16).substring(0, 8);
    q = q.substring(0, 80) + "-" + short;
  }
  return q || "unknown-query";
}
__name(normalizeId, "normalizeId");

// Confidence helpers (unchanged)
function clampMasterConfidence(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 0.97;
  const clamped = Math.max(0.9, Math.min(1, n));
  return Number(clamped.toFixed(4));
}
__name(clampMasterConfidence, "clampMasterConfidence");

function clampProvisionalConfidence(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 0.5;
  const clamped = Math.min(0.8, Math.max(0, n));
  return Number(clamped.toFixed(4));
}
__name(clampProvisionalConfidence, "clampProvisionalConfidence");

// Canonical response (unchanged)
function canonicalResponse({
  status = "ok",
  layer = "none",
  id,
  query = null,
  answer = null,
  source = "none",
  verified = false,
  provisional = false,
  eitl = null,
  meta = {},
  audit = null
}) {
  return {
    status,
    layer,
    id,
    query,
    answer,
    source,
    verified,
    provisional,
    eitl,
    meta: {
      literalVsMythos: meta.literalVsMythos ?? null,
      model: meta.model ?? null,
      confidence: meta.confidence ?? null,
      citations: meta.citations ?? [],
      created: meta.created ?? null,
      updated: meta.updated ?? null,
      qc_passed: meta.qc_passed ?? null,
      spec_version: meta.spec_version ?? SPEC_VERSION,
      reason: meta.reason ?? null
    },
    audit: audit ?? null
  };
}
__name(canonicalResponse, "canonicalResponse");

function missResponse(id, reason) {
  return canonicalResponse({
    status: "miss",
    layer: "none",
    id,
    source: "none",
    verified: false,
    provisional: false,
    meta: {
      reason,
      qc_passed: false
    }
  });
}
__name(missResponse, "missResponse");

// QC logging (unchanged, all ts are numbers)
async function logEvent(env, type, data) {
  try {
    if (!env.QC) return;
    const qcId = env.QC.idFromName("truth-qc");
    const stub = env.QC.get(qcId);
    await stub.fetch("https://qc.internal/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ts: Date.now(), ...data })
    });
  } catch (err) {
    console.warn(
      "QC log failed:",
      err && err.message ? err.message : String(err)
    );
  }
}
__name(logEvent, "logEvent");

// MASTER functions (all ts are numbers)
// Keys are stored as `master:<slug>`: normalizeId("who is the architect") gives
// "who-is-the-architect". But normalizeId also strips hyphens, so looking up the
// *id* of a stored truth ("ai-counsel-overview") produced "aicounseloverview" and
// missed a row that was sitting right there — the reason an edited truth looked
// like it had vanished. Try the direct key, the id treated as prose, and finally
// a scan that ignores hyphens entirely.
function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 100);
}
__name(slugify, "slugify");

function masterCandidates(inputOrId) {
  const raw = String(inputOrId || "").trim();
  const ids = [normalizeId(raw), slugify(raw), slugify(raw.replace(/[-_]+/g, " "))];
  return [...new Set(ids.filter(Boolean))];
}
__name(masterCandidates, "masterCandidates");

async function getMaster(env, inputOrId) {
  const ids = masterCandidates(inputOrId);
  for (const id of ids) {
    const raw = await env.MASTER_TRUTHS.get(KV_PREFIX_MASTER + id);
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      return {
        ...rec,
        id,
        created: Number(rec.created) || 0,
        updated: Number(rec.updated) || 0
      };
    } catch {
      /* try the next candidate */
    }
  }
  try {
    const wanted = new Set(ids.map((id) => id.replace(/-/g, "")));
    const listed = await env.MASTER_TRUTHS.list({ prefix: KV_PREFIX_MASTER, limit: 500 });
    for (const key of listed.keys) {
      const bare = key.name.slice(KV_PREFIX_MASTER.length);
      if (!wanted.has(bare.replace(/-/g, ""))) continue;
      const raw = await env.MASTER_TRUTHS.get(key.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        return {
          ...rec,
          id: bare,
          created: Number(rec.created) || 0,
          updated: Number(rec.updated) || 0
        };
      } catch {
        /* keep scanning */
      }
    }
  } catch (e) {
    console.error("master scan failed", e.message);
  }
  return null;
}
__name(getMaster, "getMaster");

// mind and the cards app ask in sentences; master keys are exact slugs. A close
// lexical match on the stored query is still a master hit, and it is far better
// than answering a curated question with a fresh proxy candidate.
function matchTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 24);
}
__name(matchTokens, "matchTokens");

async function findMasterByText(env, input) {
  const want = matchTokens(input);
  if (want.length < 2) return null;
  let best = null;
  try {
    const listed = await env.MASTER_TRUTHS.list({ prefix: KV_PREFIX_MASTER, limit: 500 });
    const keys = listed.keys || [];
    for (let i = 0; i < keys.length; i += 25) {
      const chunk = keys.slice(i, i + 25);
      const values = await Promise.all(
        chunk.map((k) => env.MASTER_TRUTHS.get(k.name).catch(() => null))
      );
      chunk.forEach((k, j) => {
        const raw = values[j];
        if (!raw) return;
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          return;
        }
        if (!rec || !rec.answer) return;
        const bare = k.name.slice(KV_PREFIX_MASTER.length);
        const hay = new Set(matchTokens(`${rec.query || ""} ${bare.replace(/-/g, " ")}`));
        if (!hay.size) return;
        let hits = 0;
        for (const t of want) if (hay.has(t)) hits++;
        const score = hits / want.length;
        if (!best || score > best._score) {
          best = {
            ...rec,
            id: bare,
            query: rec.query,
            created: Number(rec.created) || 0,
            updated: Number(rec.updated) || 0,
            _score: score
          };
        }
      });
    }
  } catch (e) {
    console.error("master text scan failed", e.message);
  }
  return best && best._score >= 0.75 ? best : null;
}
__name(findMasterByText, "findMasterByText");

// The admin console stores a curated answer under the question a person typed
// when saving it, keyed by that exact normalized string. Ask later in different
// words and the exact-key lookup misses, so score the stored queries lexically
// the same way the master layer does.
async function findCuratedByText(env, input) {
  const want = matchTokens(input).filter((t) => !CURATED_STOPWORDS.has(t));
  if (!want.length || !env.PROV_TRUTH) return null;
  let best = null;
  try {
    let cursor;
    let pages = 0;
    do {
      const page = await env.PROV_TRUTH.list({ prefix: KV_PREFIX_PROV, limit: 200, cursor });
      cursor = page.cursor || void 0;
      const keys = page.keys || [];
      for (let i = 0; i < keys.length; i += 25) {
        const chunk = keys.slice(i, i + 25);
        const values = await Promise.all(
          chunk.map((k) => env.PROV_TRUTH.get(k.name).catch(() => null))
        );
        chunk.forEach((k, j) => {
          const raw = values[j];
          if (!raw) return;
          let rec;
          try {
            rec = JSON.parse(raw);
          } catch {
            return;
          }
          if (!rec || !rec.answer) return;
          const bare = k.name.slice(KV_PREFIX_PROV.length);
          const hay = new Set(
            matchTokens(`${rec.query || ""} ${bare.replace(/-/g, " ")}`).filter(
              (t) => !CURATED_STOPWORDS.has(t)
            )
          );
          if (!hay.size) return;
          let hits = 0;
          for (const t of want) if (hay.has(t)) hits++;
          if (!hits) return;
          // Either direction counts: how much of the ask the row answers, and how
          // much of the row the ask names. "what is wilfat" and "tell me about
          // wilfat" both name the whole subject of a row stored as "wilfat".
          const coverage = hits / want.length;
          const precision = hits / hay.size;
          let score = Math.max(coverage, precision);
          // A hand-curated row beats an engine candidate on the same words.
          if (rec.pinned || rec.source === "justice_manual") score += 0.05;
          if (!best || score > best._score) {
            best = {
              ...rec,
              id: rec.id || bare,
              created: Number(rec.created) || 0,
              updated: Number(rec.updated) || 0,
              _score: score
            };
          }
        });
      }
      pages++;
    } while (cursor && pages < 5);
  } catch (e) {
    console.error("curated text scan failed", e.message);
  }
  return best && best._score >= 0.7 ? best : null;
}
__name(findCuratedByText, "findCuratedByText");

async function setMaster(env, { query, answer, editor, meta }) {
  const id = normalizeId(query);
  const key = KV_PREFIX_MASTER + id;
  const now = Date.now();
  const record = {
    id,
    query,
    answer,
    created: meta?.created ? Number(meta.created) : now,
    updated: now,
    editor: editor || "justice",
    source: "justice",
    verified: true,
    literalVsMythos: meta?.literalVsMythos || "literal",
    model: meta?.model || "justice-approved",
    confidence: clampMasterConfidence(meta?.confidence),
    eitlVerifier: meta?.eitlVerifier || editor || "justice",
    metadata: meta?.metadata || {}
  };
  await env.MASTER_TRUTHS.put(key, JSON.stringify(record));
  return record;
}
__name(setMaster, "setMaster");

async function updateMaster(env, {
  idOrQuery,
  answer,
  editor,
  meta,
  expectedVersion
}) {
  const id = normalizeId(idOrQuery);
  const key = KV_PREFIX_MASTER + id;
  const raw = await env.MASTER_TRUTHS.get(key);
  if (!raw) {
    const e = new Error("NOT_FOUND");
    e.code = "NOT_FOUND";
    throw e;
  }
  const existing = JSON.parse(raw);
  // Strip legacy ts strings
  existing.created = Number(existing.created) || 0;
  existing.updated = Number(existing.updated) || 0;
  if (expectedVersion && existing.version && existing.version !== expectedVersion) {
    const e = new Error("VERSION_CONFLICT");
    e.code = "VERSION_CONFLICT";
    e.current = existing;
    throw e;
  }
  const now = Date.now();
  const updated = {
    ...existing,
    id,
    answer: answer ?? existing.answer,
    updated: now,
    editor: editor || existing.editor || "justice",
    literalVsMythos: meta?.literalVsMythos || existing.literalVsMythos || "literal",
    model: meta?.model || existing.model || "justice-approved",
    confidence: meta?.confidence
      ? clampMasterConfidence(meta.confidence)
      : clampMasterConfidence(existing.confidence),
    eitlVerifier: meta?.eitlVerifier || existing.eitlVerifier || editor || "justice",
    metadata: {
      ...(existing.metadata || {}),
      ...(meta?.metadata || {})
    },
    version: Number(now)
  };
  await env.MASTER_TRUTHS.put(key, JSON.stringify(updated));
  return updated;
}
__name(updateMaster, "updateMaster");

async function deleteMaster(env, idOrQuery) {
  const id = normalizeId(idOrQuery);
  const key = KV_PREFIX_MASTER + id;
  await env.MASTER_TRUTHS.delete(key);
  return { id };
}
__name(deleteMaster, "deleteMaster");

// PROVISIONAL functions

// getProvisional: supports new-style + legacy keys; all ts are numbers
async function getProvisional(env, inputOrId) {
  const id = normalizeId(inputOrId);
  if (!env.PROV_TRUTH) return null;

  const newKey = KV_PREFIX_PROV + id;          // "provisional:<id>"
  const legacyKey = `truth:provisional:${id}`; // legacy

  let rawProv = await env.PROV_TRUTH.get(newKey);
  let key = newKey;
  if (!rawProv) {
    rawProv = await env.PROV_TRUTH.get(legacyKey);
    key = legacyKey;
  }
  if (!rawProv) return null;

  try {
    const rec = JSON.parse(rawProv);
    rec.created = Number(rec.created) || 0;
    rec.updated = Number(rec.updated) || 0;
    return { id, ...rec };
  } catch {
    return null;
  }
}
__name(getProvisional, "getProvisional");

// setProvisional: writes new-style keys; all ts are numbers
async function setProvisional(env, {
  query,
  answer,
  source,
  model,
  confidence,
  citations,
  meta
}) {
  const id = normalizeId(query);
  const key = KV_PREFIX_PROV + id;
  const now = Date.now();
  const record = {
    id,
    query,
    answer,
    source: source || "proxy_ai_candidate",
    model: model || "proxy-model",
    confidence: clampProvisionalConfidence(confidence),
    citations: citations || [],
    created: meta?.created ? Number(meta.created) : now,
    updated: now,
    provisional: true,
    verified: false,
    qc_passed: meta?.qc_passed !== false
  };
  // No expiry here either: the engine may write this row and a person may pick
  // it up later, and a day-long clock was the whole problem.
  await env.PROV_TRUTH.put(key, JSON.stringify(record));
  return record;
}
__name(setProvisional, "setProvisional");

// getMemory: read-only lookup for the main memory rows (`truth:<id>`).
// The resolver missed these entirely: getProvisional only looks at "provisional:"
// and "truth:provisional:", while the store is keyed "truth:<id>".
// Read-only on purpose — nothing here can write or delete a memory row.
async function getMemory(env, inputOrId) {
  const id = normalizeId(inputOrId);
  if (!env.PROV_TRUTH) return null;
  const raw = await env.PROV_TRUTH.get("truth:" + id);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    rec.id = rec.id || id;
    rec.created = Number(rec.created || rec.timestamp) || 0;
    rec.updated =
      Number(rec.updated || rec.edited || rec.timestamp) || rec.created;
    return rec;
  } catch {
    return null;
  }
}
__name(getMemory, "getMemory");

// --- Memoria: the index that makes memory rows findable --------------------
// One KV value maps id -> { w: searchable words, u: updated, c: answer length }.
// Search reads this single key, scores, then fetches at most three records.
async function readMemoriaIndex(env) {
  const blank = { version: 1, updated: null, count: 0, entries: {} };
  if (!env.PROV_TRUTH) return blank;
  try {
    const raw = await env.PROV_TRUTH.get(MEMORIA_INDEX_KEY);
    if (!raw) return blank;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return blank;
    return parsed;
  } catch (err) {
    console.error("memoria index read failed", err && err.message);
    return blank;
  }
}
__name(readMemoriaIndex, "readMemoriaIndex");

async function writeMemoriaIndex(env, index) {
  if (!env.PROV_TRUTH) return false;
  await env.PROV_TRUTH.put(MEMORIA_INDEX_KEY, JSON.stringify(index));
  return true;
}
__name(writeMemoriaIndex, "writeMemoriaIndex");

function memoriaEntry(rec, id) {
  const words = matchTokens(`${(rec && rec.query) || ""} ${String(id || "").replace(/-/g, " ")}`);
  return {
    w: [...new Set(words)].join(" "),
    u: Number((rec && (rec.updated || rec.created)) || 0),
    c: String((rec && rec.answer) || "").length
  };
}
__name(memoriaEntry, "memoriaEntry");

async function findMemoryByText(env, input) {
  if (!env.PROV_TRUTH) return null;
  const want = matchTokens(input);
  if (want.length < 2) return null;
  const index = await readMemoriaIndex(env);
  const ids = Object.keys(index.entries || {});
  if (!ids.length) return null;
  const scored = [];
  for (const id of ids) {
    const hay = new Set(String(index.entries[id].w || "").split(" ").filter(Boolean));
    if (!hay.size) continue;
    let hits = 0;
    for (const t of want) if (hay.has(t)) hits++;
    if (hits < 2) continue;
    scored.push({ id, score: hits / want.length });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  const raws = await Promise.all(
    top.map((t) => env.PROV_TRUTH.get(MEMORIA_PREFIX + t.id).catch(() => null))
  );
  let best = null;
  raws.forEach((raw, i) => {
    if (!raw) return;
    let rec;
    try { rec = JSON.parse(raw); } catch { return; }
    if (!rec || !rec.answer) return;
    if (!best || top[i].score > best._score) {
      best = { ...rec, id: rec.id || top[i].id, _score: top[i].score };
    }
  });
  if (!best || best._score < MEMORIA_MIN_SCORE) return null;
  best.created = Number(best.created || best.timestamp) || 0;
  best.updated = Number(best.updated || best.edited || best.timestamp) || best.created;
  return best;
}
__name(findMemoryByText, "findMemoryByText");

// updateProvisional: create-or-update for Justice; all ts are numbers
async function updateProvisional(env, { idOrQuery, answer, meta }) {
  const id = normalizeId(idOrQuery);
  const key = KV_PREFIX_PROV + id;
  const now = Date.now();

  const raw = await env.PROV_TRUTH.get(key);

  if (!raw) {
    // If no existing record: create, but only if answer is provided
    if (!answer) {
      const e = new Error("NOT_FOUND");
      e.code = "NOT_FOUND";
      throw e;
    }

    const record = {
      id,
      query: idOrQuery,
      answer,
      source: "justice_manual",
      model: meta?.model || "manual",
      confidence: clampProvisionalConfidence(meta?.confidence),
      citations: meta?.citations || [],
      created: now,
      updated: now,
      provisional: true,
      pinned: true,
      verified: false,
      qc_passed: meta?.qc_passed !== false
    };

    // No expirationTtl: a saved truth stays until a person deletes it. This is
    // the bug that made console saves vanish after a day.
    await archiveProvisional(env, record);
    await env.PROV_TRUTH.put(key, JSON.stringify(record));
    return record;
  }

  // Update existing record
  const existing = JSON.parse(raw);
  existing.created = Number(existing.created) || 0;
  existing.updated = Number(existing.updated) || 0;

  const updated = {
    ...existing,
    id,
    answer: answer ?? existing.answer,
    provisional: true,
    pinned: true,
    updated: now,
    confidence: clampProvisionalConfidence(
      meta?.confidence ?? existing.confidence
    ),
    citations: meta?.citations || existing.citations || [],
    qc_passed:
      meta?.qc_passed !== void 0
        ? !!meta.qc_passed
        : existing.qc_passed
  };

  // Editing re-writes the row with no TTL, which also clears a TTL left behind
  // by an older build (or by an auto candidate a person then edited).
  await archiveProvisional(env, updated);
  await env.PROV_TRUTH.put(key, JSON.stringify(updated));
  return updated;
}
__name(updateProvisional, "updateProvisional");

async function deleteProvisional(env, idOrQuery) {
  const id = normalizeId(idOrQuery);
  const key = KV_PREFIX_PROV + id;
  await env.PROV_TRUTH.delete(key);
  await unarchiveProvisional(env, id);
  return { id };
}
__name(deleteProvisional, "deleteProvisional");

// ARCHIVE: a second copy in R2 (bucket ai-nspired) so a KV mistake, an expired
// old row or a bad delete can never take a saved truth with it.
async function archiveProvisional(env, record) {
  if (!env.TBACKED || !record || !record.id) return false;
  const id = normalizeId(record.id);
  try {
    await env.TBACKED.put(ARCHIVE_PREFIX + id + ".json", JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { id, archived_at: String(Date.now()) }
    });
    return true;
  } catch (err) {
    // The KV write must still land even if the bucket is unhappy.
    console.error("archiveProvisional failed", id, err && err.message);
    return false;
  }
}
__name(archiveProvisional, "archiveProvisional");

async function unarchiveProvisional(env, id) {
  if (!env.TBACKED) return false;
  try {
    await env.TBACKED.delete(ARCHIVE_PREFIX + normalizeId(id) + ".json");
    return true;
  } catch (err) {
    console.error("unarchiveProvisional failed", id, err && err.message);
    return false;
  }
}
__name(unarchiveProvisional, "unarchiveProvisional");

// restoreProvisionals: pull every archived row back into KV, never overwriting
// a row that is newer than its archive copy.
async function restoreProvisionals(env) {
  if (!env.TBACKED || !env.PROV_TRUTH) return { restored: 0, skipped: 0, failed: 0 };
  const out = { restored: 0, skipped: 0, failed: 0 };
  let cursor;
  do {
    const page = await env.TBACKED.list({ prefix: ARCHIVE_PREFIX, limit: 500, cursor });
    cursor = page.truncated ? page.cursor : undefined;
    for (const obj of page.objects || []) {
      try {
        const stored = await env.TBACKED.get(obj.key);
        if (!stored) { out.failed++; continue; }
        const rec = JSON.parse(await stored.text());
        if (!rec || !rec.id || typeof rec.answer !== "string" || !rec.answer.trim()) {
          out.failed++;
          continue;
        }
        const id = normalizeId(rec.id);
        const key = KV_PREFIX_PROV + id;
        const live = await env.PROV_TRUTH.get(key);
        if (live) {
          const liveRec = JSON.parse(live);
          if ((Number(liveRec.updated) || 0) >= (Number(rec.updated) || 0)) {
            out.skipped++;
            continue;
          }
        }
        await env.PROV_TRUTH.put(key, JSON.stringify({ ...rec, id, pinned: true }));
        out.restored++;
      } catch {
        out.failed++;
      }
    }
  } while (cursor);
  return out;
}
__name(restoreProvisionals, "restoreProvisionals");

// *** NEW: queryProvisionals ***
async function queryProvisionals(env, { query, limit = 20 }) {
  const id = normalizeId(query);
  let keyPrefix = KV_PREFIX_PROV;
  if (id !== "unknown-query") keyPrefix = keyPrefix + id;

  const list = await env.PROV_TRUTH.list({ prefix: keyPrefix, limit: Number(limit) });
  const results = [];
  for (const meta of list.keys) {
    const raw = await env.PROV_TRUTH.get(meta.name);
    if (!raw) continue;
    try {
      let obj = JSON.parse(raw);
      obj.created = Number(obj.created) || 0;
      obj.updated = Number(obj.updated) || 0;
      obj.id = obj.id || normalizeId(obj.query);
      results.push(obj);
    } catch { /* ignore corrupt */ }
  }
  return results;
}
__name(queryProvisionals, "queryProvisionals");

// PROXY: strict JSON-array instruction
async function requestCandidateFromProxy(env, { id, query }) {
  if (!env.PROXY) throw new Error("PROXY service not bound");
  const spec = {
    id,
    query,
    spec_version: SPEC_VERSION,
    model: "mistralai/mistral-nemo", // must be present
    instruction:
      "You are a backend JSON generator. Return ONLY a valid JSON array of candidate truths matching the provided JSON Schema. No prose, no markdown, no extra keys.",
    schema: {
      type: "array",
      items: {
        type: "object",
        required: ["answer"],
        properties: {
          answer: { type: "string" },
          model: { type: "string" },
          confidence: { type: "number" },
          citations: { type: "array" }
        }
      }
    }
  };
  // A service binding requires an absolute URL; a relative path throws before
  // the request leaves the isolate, which surfaced only as an unexplained miss.
  const res = await env.PROXY.fetch("https://ai-proxy/candidate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec)
  });
  if (!res.ok) {
    throw new Error("PROXY error " + res.status);
  }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("NO_CANDIDATE");
  }
  return data;
}
__name(requestCandidateFromProxy, "requestCandidateFromProxy");

// Candidate via op, the pi harness. The proxy route below asks a small model
// for a JSON array and usually answers nothing usable; op keeps a conversation
// per query id, can search, and answers in prose.
var OP_AGENT_URL = "https://pi-harness-example.ai-n.workers.dev/api/assistant";

async function requestCandidateFromOp(env, { id, query }) {
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-agent-protocol": "1",
      "x-agent": "truth"
    },
    body: JSON.stringify({
      message: query,
      preset: "truth",
      session: "truth:" + String(id).slice(0, 96),
      from: "truth"
    })
  };
  // A service binding, not the workers.dev URL: Cloudflare answers a Worker's
  // HTTPS request to another Worker on the same account with error 1042.
  const res = env.OP
    ? await env.OP.fetch("https://op/api/assistant", init)
    : await fetch(OP_AGENT_URL, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("op error " + res.status + " " + detail.slice(0, 220));
  }
  const data = await res.json();
  const answer = typeof data.text === "string" ? data.text.trim() : "";
  if (!answer) throw new Error("NO_CANDIDATE");
  return [
    {
      answer,
      model: data.model || "op",
      confidence: null,
      citations: [],
      source: "op_candidate"
    }
  ];
}
__name(requestCandidateFromOp, "requestCandidateFromOp");

// Admin gate: writes stay open until ADMIN_KEY is set as a secret on this Worker,
// then every mutating route requires the x-admin-key header the console sends.
// Reads (resolve, provisional/query, /debug/kv-status) stay public either way.
var ADMIN_WRITE_PATHS = new Set([
  "/api/truth/master/create",
  "/api/truth/master/update",
  "/api/truth/master/delete",
  "/api/truth/provisional/update",
  "/api/truth/provisional/delete",
  "/api/truth/provisional/restore",
  "/api/truth/promote",
  "/api/truth/audit",
  "/api/truth/memory/intake",
  "/api/truth/memory/reindex"
]);

function adminRequired(env, request, path) {
  if (!env.ADMIN_KEY) return null;
  if (!ADMIN_WRITE_PATHS.has(path)) return null;
  const given = request.headers.get("x-admin-key") || "";
  if (given.length === env.ADMIN_KEY.length) {
    let diff = 0;
    for (let i = 0; i < given.length; i++) {
      diff |= given.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
    }
    if (diff === 0) return null;
  }
  return new Response(
    JSON.stringify({
      error: "admin_key_required",
      message: "Send the ADMIN_KEY in the x-admin-key header."
    }),
    { status: 401, headers: CORS_HEADERS }
  );
}
__name(adminRequired, "adminRequired");

// POST /api/truth/memory/intake — the way a new memory truth arrives: written
// once, never given a clock, indexed in the same call so it is findable at once.
async function handleMemoryIntake(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: CORS_HEADERS });
  }
  const query = String(body.query || body.input || "").trim();
  const answer = String(body.answer || "").trim();
  if (!query || !answer) {
    return new Response(JSON.stringify({ error: "query_and_answer_required" }), { status: 400, headers: CORS_HEADERS });
  }
  if (answer.length < 20) {
    return new Response(JSON.stringify({ error: "answer_too_short", message: "An answer under 20 characters teaches nothing." }), { status: 400, headers: CORS_HEADERS });
  }
  if (!env.PROV_TRUTH) {
    return new Response(JSON.stringify({ error: "memory_store_unavailable", message: "The PROV_TRUTH namespace is not bound." }), { status: 503, headers: CORS_HEADERS });
  }
  const id = normalizeId(query);
  const now = Date.now();
  let prev = null;
  try {
    const raw = await env.PROV_TRUTH.get(MEMORIA_PREFIX + id);
    if (raw) prev = JSON.parse(raw);
  } catch (err) {
    console.error("memory prior read failed", id, err && err.message);
  }
  const record = {
    id,
    query: query.slice(0, 500),
    answer: answer.slice(0, 8000),
    source: String(body.source || "intake"),
    model: body.model ? String(body.model) : ((prev && prev.model) || null),
    confidence: clampProvisionalConfidence(body.confidence ?? (prev && prev.confidence)),
    citations: Array.isArray(body.citations) ? body.citations.slice(0, 20) : ((prev && prev.citations) || []),
    created: (prev && Number(prev.created)) || now,
    updated: now,
    provisional: true,
    verified: false,
    qc_passed: body.qc_passed === true || (prev && prev.qc_passed === true)
  };
  // No expirationTtl, and that is the point: a memory truth is not a cache entry.
  await env.PROV_TRUTH.put(MEMORIA_PREFIX + id, JSON.stringify(record));
  const index = await readMemoriaIndex(env);
  index.entries[id] = memoriaEntry(record, id);
  index.updated = new Date(now).toISOString();
  index.count = Object.keys(index.entries).length;
  await writeMemoriaIndex(env, index);
  return new Response(JSON.stringify({
    success: true, id, created: !prev, indexed: true, count: index.count
  }), { status: 200, headers: CORS_HEADERS });
}
__name(handleMemoryIntake, "handleMemoryIntake");

// POST /api/truth/memory/reindex — brings the rows that predate the index into it.
// Bounded and resumable: KV lists and gets are subrequests, so one call indexes at
// most `limit` rows and hands back a cursor instead of trying to walk 1150 at once.
async function handleMemoryReindex(request, env) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const asked = parseInt(String(body.limit || url.searchParams.get("limit") || "200"), 10);
  const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 200, 1), 500);
  const cursor = body.cursor || url.searchParams.get("cursor") || void 0;
  const reset = body.reset === true || url.searchParams.get("reset") === "1";
  if (!env.PROV_TRUTH) {
    return new Response(JSON.stringify({ error: "memory_store_unavailable" }), { status: 503, headers: CORS_HEADERS });
  }
  const index = reset ? { version: 1, updated: null, count: 0, entries: {} } : await readMemoriaIndex(env);
  const page = await env.PROV_TRUTH.list({ prefix: MEMORIA_PREFIX, limit, cursor });
  let indexed = 0;
  let skipped = 0;
  for (const key of page.keys || []) {
    const raw = await env.PROV_TRUTH.get(key.name).catch(() => null);
    if (!raw) { skipped++; continue; }
    let rec;
    try { rec = JSON.parse(raw); } catch { skipped++; continue; }
    if (!rec || !rec.answer) { skipped++; continue; }
    const id = key.name.slice(MEMORIA_PREFIX.length);
    index.entries[id] = memoriaEntry(rec, id);
    indexed++;
  }
  index.updated = new Date().toISOString();
  index.count = Object.keys(index.entries).length;
  await writeMemoriaIndex(env, index);
  return new Response(JSON.stringify({
    success: true, indexed, skipped, count: index.count,
    done: !page.truncated, cursor: page.truncated ? page.cursor : null
  }), { status: 200, headers: CORS_HEADERS });
}
__name(handleMemoryReindex, "handleMemoryReindex");

// /api/truth/audit — write one audit record. Gated by ADMIN_KEY like every
// other write; the record itself is the caller's, not re-derived here.
async function handleAuditSave(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400, headers: CORS_HEADERS
    });
  }
  if (!env.TBACKED) {
    return new Response(JSON.stringify({
      error: "audit_store_unavailable",
      message: "The TBACKED bucket is not bound to this Worker."
    }), { status: 503, headers: CORS_HEADERS });
  }
  const given = String(body.id || body.audit_id || "").trim();
  if (given && !AUDIT_ID_RE.test(given)) {
    return new Response(JSON.stringify({ error: "invalid_audit_id" }), {
      status: 400, headers: CORS_HEADERS
    });
  }
  const id = given || crypto.randomUUID();

  // The page saves the same audit more than once: the first call creates it and
  // later calls carry only what changed. So a save merges onto the stored record
  // instead of replacing it, and the audit text already kept is not lost.
  let prev = null;
  try {
    const stored = await env.TBACKED.get(AUDIT_PREFIX + id + ".json");
    if (stored) prev = await stored.json();
  } catch (err) {
    console.error("audit prior read failed", id, err && err.message);
  }
  const pick = (...keys) => {
    for (const k of keys) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k];
    }
    return void 0;
  };

  const content = String(pick("content", "query") ?? (prev && prev.content) ?? "").trim();
  if (!content) {
    return new Response(JSON.stringify({ error: "content_required" }), {
      status: 400, headers: CORS_HEADERS
    });
  }
  if (content.length > 200000) {
    return new Response(JSON.stringify({ error: "content_too_large" }), {
      status: 413, headers: CORS_HEADERS
    });
  }

  const fullText = pick("fullText", "full_text", "lastResponse", "last_response");
  const messages = pick("messages");
  const createdAt = pick("createdAt", "created_at");
  const savedAt = new Date().toISOString();

  const record = {
    id,
    type: String(pick("type") ?? (prev && prev.type) ?? "docket"),
    content,
    full_text: typeof fullText === "string"
      ? fullText.slice(0, 400000)
      : (prev && prev.full_text) || null,
    messages: Array.isArray(messages)
      ? messages.slice(-100)
      : (prev && Array.isArray(prev.messages) ? prev.messages : []),
    scores: (body.scores && typeof body.scores === "object" && body.scores) || (prev && prev.scores) || null,
    domain: (typeof body.domain === "string" && body.domain) || (prev && prev.domain) || null,
    searches: Array.isArray(body.searches) ? body.searches.slice(0, 50) : (prev && prev.searches) || [],
    evidentiary_gate: pick("evidentiary_gate") ?? (prev && prev.evidentiary_gate) ?? null,
    created_at: String(createdAt ?? (prev && prev.created_at) ?? savedAt),
    updated_at: savedAt,
    saved_at: savedAt,
    saved_count: ((prev && prev.saved_count) || 0) + 1,
    spec_version: SPEC_VERSION
  };

  try {
    await env.TBACKED.put(AUDIT_PREFIX + id + ".json", JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { id, saved_at: savedAt }
    });
  } catch (err) {
    console.error("audit save failed", id, err && err.message);
    return new Response(JSON.stringify({
      error: "audit_save_failed", message: err && err.message ? err.message : "bucket write failed"
    }), { status: 502, headers: CORS_HEADERS });
  }
  return new Response(JSON.stringify({
    success: true, id, audit_id: id, stored: true, created: !prev, saved_at: savedAt
  }), { status: 200, headers: CORS_HEADERS });
}
__name(handleAuditSave, "handleAuditSave");

// GET /api/truth/audit/<id> — public read, like provisional/query. This is what
// makes a link back to an audit mean something.
async function handleAuditRead(env, id) {
  if (!AUDIT_ID_RE.test(id)) {
    return new Response(JSON.stringify({ error: "invalid_audit_id" }), {
      status: 400, headers: CORS_HEADERS
    });
  }
  if (!env.TBACKED) {
    return new Response(JSON.stringify({
      error: "audit_store_unavailable",
      message: "The TBACKED bucket is not bound to this Worker."
    }), { status: 503, headers: CORS_HEADERS });
  }
  const obj = await env.TBACKED.get(AUDIT_PREFIX + id + ".json");
  if (!obj) {
    return new Response(JSON.stringify({
      error: "audit_not_found",
      message: "Nothing is stored under that id."
    }), { status: 404, headers: CORS_HEADERS });
  }
  let record = null;
  try {
    record = await obj.json();
  } catch (err) {
    console.error("audit read failed", id, err && err.message);
  }
  if (!record) {
    return new Response(JSON.stringify({ error: "audit_unreadable" }), {
      status: 500, headers: CORS_HEADERS
    });
  }
  // The page's reader unwraps `audit` (or reads the record at the top level) and
  // needs messages plus fullText/full_text to render anything; `record` alone
  // reads as "the Worker returned something that is not an audit".
  return new Response(JSON.stringify({ success: true, audit: record }), {
    status: 200, headers: CORS_HEADERS
  });
}
__name(handleAuditRead, "handleAuditRead");

// ROUTER

var truthHandler = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const gate = adminRequired(env, request, path);
      if (gate) return gate;

      if (path === "/api/truth/resolve" && request.method === "POST") {
        return await handleResolve(request, env);
      }
      if (path === "/api/truth/master/create" && request.method === "POST") {
        return await handleMasterCreate(request, env);
      }
      if (path === "/api/truth/master/update" && request.method === "POST") {
        return await handleMasterUpdate(request, env);
      }
      if (path === "/api/truth/master/delete" && request.method === "POST") {
        return await handleMasterDelete(request, env);
      }
      if (path === "/api/truth/provisional/update" && request.method === "POST") {
        return await handleProvisionalUpdate(request, env);
      }
      if (path === "/api/truth/provisional/delete" && request.method === "POST") {
        return await handleProvisionalDelete(request, env);
      }
      if (path === "/api/truth/provisional/query" && request.method === "GET") {
        return await handleProvisionalQuery(request, env);
      }
      if (path === "/api/truth/provisional/restore" && request.method === "POST") {
        return await handleProvisionalRestore(request, env);
      }
      if (path === "/debug/archive-status" && request.method === "GET") {
        return await handleArchiveStatus(env);
      }
      if (path === "/api/truth/promote" && request.method === "POST") {
        return await handlePromote(request, env);
      }
      if (path === "/debug/kv-status" && request.method === "GET") {
        return await handleKVStatus(env);
      }

      if (path === "/api/truth/memory/intake" && request.method === "POST") {
        return await handleMemoryIntake(request, env);
      }
      if (path === "/api/truth/memory/reindex" && request.method === "POST") {
        return await handleMemoryReindex(request, env);
      }
      if (path === "/api/truth/audit" && request.method === "POST") {
        return await handleAuditSave(request, env);
      }
      if (path.startsWith("/api/truth/audit/") && request.method === "GET") {
        return await handleAuditRead(env, decodeURIComponent(path.slice("/api/truth/audit/".length)));
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: CORS_HEADERS
      });
    } catch (err) {
      console.error("truth worker error:", err);
      return new Response(
        JSON.stringify({ error: err.message || "Internal error" }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }
};

// /api/truth/resolve

async function handleResolve(request, env) {
  const body = await request.json().catch(() => ({}));
  const input = (body.input || "").trim();

  if (!input) {
    return new Response(JSON.stringify({ error: "input required" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  const id = normalizeId(input);

  // 1) MASTER
  const master = await getMaster(env, input);
  if (master && master.answer) {
    const resp = canonicalResponse({
      status: "ok",
      layer: "master",
      id: master.id,
      query: master.query || input,
      answer: master.answer,
      source: "master_truth",
      verified: true,
      provisional: false,
      eitl: {
        verifier: master.eitlVerifier || master.editor || "justice",
        last_editor: master.editor || "justice"
      },
      meta: {
        literalVsMythos: master.literalVsMythos || "literal",
        model: master.model || "justice-approved",
        confidence: clampMasterConfidence(master.confidence),
        citations: (master.metadata && master.metadata.citations) || [],
        created: master.created,
        updated: master.updated,
        qc_passed: true
      }
    });
    await logEvent(env, "master_hit", { id: master.id, layer: "master" });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 1b) MASTER by text — a curated answer beats minting a new candidate.
  const textMaster = await findMasterByText(env, input);
  if (textMaster && textMaster.answer) {
    const resp = canonicalResponse({
      status: "ok",
      layer: "master",
      id: textMaster.id,
      query: textMaster.query || input,
      answer: textMaster.answer,
      source: "master_truth",
      verified: true,
      provisional: false,
      eitl: {
        verifier: textMaster.eitlVerifier || textMaster.editor || "justice",
        last_editor: textMaster.editor || "justice"
      },
      meta: {
        literalVsMythos: textMaster.literalVsMythos || "literal",
        model: textMaster.model || "justice-approved",
        confidence: clampMasterConfidence(textMaster.confidence),
        citations: (textMaster.metadata && textMaster.metadata.citations) || [],
        created: textMaster.created,
        updated: textMaster.updated,
        qc_passed: true,
        match: "text",
        matched_query: textMaster.query || textMaster.id,
        score: textMaster._score
      }
    });
    await logEvent(env, "master_text_hit", {
      id: textMaster.id,
      score: textMaster._score
    });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 2) CURATED (what the admin console saves) and engine candidates
  const prov = await getProvisional(env, input);
  if (prov && prov.answer) {
    // Name the layer after its origin: a hand-curated save is not a candidate.
    const provLayer = prov.pinned || prov.source === "justice_manual" ? "curated" : "provisional";
    const resp = canonicalResponse({
      status: "ok",
      layer: provLayer,
      id: prov.id,
      query: prov.query || input,
      answer: prov.answer,
      source: prov.source || "provisional_truth",
      verified: false,
      provisional: true,
      eitl: prov.eitl || null,
      meta: {
        model: prov.model || "proxy-model",
        confidence: clampProvisionalConfidence(prov.confidence),
        citations: prov.citations || [],
        created: prov.created,
        updated: prov.updated,
        qc_passed: prov.qc_passed === true
      }
    });
    await logEvent(env, "provisional_hit", {
      id: prov.id,
      layer: "provisional"
    });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 2a) CURATED by text — the saved question and the later query rarely match
  // exactly, and a curated answer must beat minting a new candidate.
  const curated = await findCuratedByText(env, input);
  if (curated && curated.answer) {
    const isCurated = curated.pinned || curated.source === "justice_manual";
    const resp = canonicalResponse({
      status: "ok",
      layer: isCurated ? "curated" : "provisional",
      id: curated.id,
      query: curated.query || input,
      answer: curated.answer,
      source: curated.source || "admin_curated",
      verified: false,
      provisional: true,
      curated: isCurated,
      eitl: curated.eitl || null,
      meta: {
        model: curated.model || "manual",
        confidence: clampProvisionalConfidence(curated.confidence),
        citations: curated.citations || [],
        created: curated.created,
        updated: curated.updated,
        qc_passed: curated.qc_passed === true,
        match: "text",
        matched_query: curated.query || null,
        score: Number((curated._score || 0).toFixed(3))
      }
    });
    await logEvent(env, "curated_text_hit", { id: curated.id, score: curated._score });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 2b) MEMORY (`truth:<id>` in the same namespace)
  const memory = await getMemory(env, input);
  if (memory && memory.answer) {
    const resp = canonicalResponse({
      status: "ok",
      layer: "provisional",
      id: memory.id,
      query: input,
      answer: memory.answer,
      source: "memory_truth",
      verified: false,
      provisional: true,
      eitl: null,
      meta: {
        model: memory.model || null,
        confidence: clampProvisionalConfidence(memory.confidence),
        citations: memory.citations || [],
        created: memory.created,
        updated: memory.updated,
        qc_passed: memory.qc_passed === true
      }
    });
    await logEvent(env, "memory_hit", { id: memory.id, layer: "memory" });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 2c) MEMORY by text — the exact-id lookup above only fires when the query
  // slugifies to a stored id, which is why 1150 rows sat unreachable. The index
  // makes them answerable.
  const memoria = await findMemoryByText(env, input);
  if (memoria && memoria.answer) {
    const resp = canonicalResponse({
      status: "ok",
      layer: "provisional",
      id: memoria.id,
      query: memoria.query || input,
      answer: memoria.answer,
      source: memoria.source || "memory_truth",
      verified: false,
      provisional: true,
      eitl: null,
      meta: {
        model: memoria.model || null,
        confidence: clampProvisionalConfidence(memoria.confidence),
        citations: memoria.citations || [],
        created: memoria.created,
        updated: memoria.updated,
        qc_passed: memoria.qc_passed === true,
        match: "text",
        score: Number((memoria._score || 0).toFixed(3))
      }
    });
    await logEvent(env, "memory_text_hit", { id: memoria.id, score: memoria._score });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 3) Candidate via PROXY
  try {
    await logEvent(env, "candidate_requested", { id, layer: "none" });
    let candidates = [];
    try {
      candidates = await requestCandidateFromOp(env, { id, query: input });
    } catch (opErr) {
      console.error("op candidate failed:", opErr.message || opErr);
      await logEvent(env, "candidate_op_failed", {
        id,
        layer: "none",
        error: opErr.message || String(opErr)
      });
    }
    if (!candidates.length) {
      candidates = await requestCandidateFromProxy(env, {
        id,
        query: input
      });
    }
    const cand = candidates[0];
    if (!cand || typeof cand.answer !== "string" || !cand.answer.trim()) {
      throw new Error("INVALID_CANDIDATE");
    }

    const rec = await setProvisional(env, {
      query: input,
      answer: cand.answer.trim(),
      source: cand.source || "proxy_ai_candidate",
      model: cand.model,
      confidence: cand.confidence,
      citations: Array.isArray(cand.citations) ? cand.citations : [],
      meta: { qc_passed: true }
    });

    await logEvent(env, "provisional_created", {
      id: rec.id,
      layer: "provisional"
    });

    if (env.JUSTICE) {
      env.JUSTICE.fetch("/notify/provisional", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: rec.id,
          query: rec.query,
          created: rec.created
        })
      }).catch(() => {});
    }

    const resp = canonicalResponse({
      status: "ok",
      layer: "provisional",
      id: rec.id,
      query: rec.query,
      answer: rec.answer,
      source: rec.source,
      verified: false,
      provisional: true,
      eitl: null,
      meta: {
        model: rec.model,
        confidence: rec.confidence,
        citations: rec.citations,
        created: rec.created,
        updated: rec.updated,
        qc_passed: true
      }
    });

    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  } catch (err) {
    console.error("candidate flow error:", err.message || err);
    await logEvent(env, "candidate_failed", {
      id,
      layer: "none",
      error: err.message || String(err)
    });
    const miss = missResponse(
      id,
      "no_master_memory_or_provisional_and_no_valid_candidate"
    );
    return new Response(JSON.stringify(miss), {
      status: 200,
      headers: CORS_HEADERS
    });
  }
}
__name(handleResolve, "handleResolve");

// Admin handlers

async function handleMasterCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.input || !body.answer) {
    return new Response(JSON.stringify({ error: "input and answer required" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  const record = await setMaster(env, {
    query: body.input,
    answer: body.answer,
    editor: body.editor || "justice",
    meta: body.meta || {}
  });
  await logEvent(env, "master_created", { id: record.id, layer: "master" });
  const resp = canonicalResponse({
    status: "ok",
    layer: "master",
    id: record.id,
    query: record.query,
    answer: record.answer,
    source: "master_truth",
    verified: true,
    provisional: false,
    eitl: {
      verifier: record.eitlVerifier || "justice",
      last_editor: record.editor || "justice"
    },
    meta: {
      literalVsMythos: record.literalVsMythos,
      model: record.model,
      confidence: clampMasterConfidence(record.confidence),
      citations:
        (record.metadata && record.metadata.citations) || [],
      created: record.created,
      updated: record.updated,
      qc_passed: true
    }
  });
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: CORS_HEADERS
  });
}
__name(handleMasterCreate, "handleMasterCreate");

async function handleMasterUpdate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.input || !body.answer) {
    return new Response(JSON.stringify({ error: "input and answer required" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  try {
    const record = await updateMaster(env, {
      idOrQuery: body.input,
      answer: body.answer,
      editor: body.editor || "justice",
      meta: body.meta || {},
      expectedVersion: body.expectedVersion
    });
    await logEvent(env, "master_updated", {
      id: record.id,
      layer: "master"
    });
    const resp = canonicalResponse({
      status: "ok",
      layer: "master",
      id: record.id,
      query: record.query,
      answer: record.answer,
      source: "master_truth",
      verified: true,
      provisional: false,
      eitl: {
        verifier: record.eitlVerifier || "justice",
        last_editor: record.editor || "justice"
      },
      meta: {
        literalVsMythos: record.literalVsMythos,
        model: record.model,
        confidence: clampMasterConfidence(record.confidence),
        citations:
          (record.metadata && record.metadata.citations) || [],
        created: record.created,
        updated: record.updated,
        qc_passed: true
      }
    });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  } catch (err) {
    if (err.code === "VERSION_CONFLICT") {
      return new Response(
        JSON.stringify({
          error: "VERSION_CONFLICT",
          current: err.current
        }),
        { status: 409, headers: CORS_HEADERS }
      );
    }
    if (err.code === "NOT_FOUND") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: CORS_HEADERS
      });
    }
    throw err;
  }
}
__name(handleMasterUpdate, "handleMasterUpdate");

async function handleMasterDelete(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.input) {
    return new Response(JSON.stringify({ error: "input required" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  const { id } = await deleteMaster(env, body.input);
  await logEvent(env, "master_deleted", { id, layer: "master" });
  if (env.JUSTICE) {
    env.JUSTICE.fetch("/notify/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, layer: "master" })
    }).catch(() => {});
  }
  return new Response(JSON.stringify({ success: true, id }), {
    status: 200,
    headers: CORS_HEADERS
  });
}
__name(handleMasterDelete, "handleMasterDelete");

async function handleProvisionalUpdate(request, env) {
  const body = await request.json().catch(() => ({}));
  const idOrInput = body.id || body.input;
  if (!idOrInput) {
    return new Response(JSON.stringify({ error: "id or input required" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  try {
    const rec = await updateProvisional(env, {
      idOrQuery: idOrInput,
      answer: body.answer,
      meta: body.meta || {}
    });
    await logEvent(env, "provisional_updated", {
      id: rec.id,
      layer: "provisional"
    });
    const resp = canonicalResponse({
      status: "ok",
      layer: "curated",
      id: rec.id,
      query: rec.query,
      answer: rec.answer,
      source: "admin_curated",
      verified: false,
      provisional: true,
      curated: true,
      eitl: rec.eitl || null,
      meta: {
        model: rec.model,
        confidence: clampProvisionalConfidence(rec.confidence),
        citations: rec.citations || [],
        created: rec.created,
        updated: rec.updated,
        qc_passed: rec.qc_passed === true
      }
    });
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: CORS_HEADERS
    });
  } catch (err) {
    if (err.code === "NOT_FOUND") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: CORS_HEADERS
      });
    }
    throw err;
  }
}
__name(handleProvisionalUpdate, "handleProvisionalUpdate");

async function handleProvisionalDelete(request, env) {
  const body = await request.json().catch(() => ({}));
  const idOrInput = body.id || body.input;
  if (!idOrInput) {
    return new Response(JSON.stringify({ error: "id or input required" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  const { id } = await deleteProvisional(env, idOrInput);
  await logEvent(env, "provisional_deleted", {
    id,
    layer: "provisional"
  });
  if (env.JUSTICE) {
    env.JUSTICE.fetch("/notify/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, layer: "provisional" })
    }).catch(() => {});
  }
  return new Response(JSON.stringify({ success: true, id }), {
    status: 200,
    headers: CORS_HEADERS
  });
}
__name(handleProvisionalDelete, "handleProvisionalDelete");

// *** NEW: handleProvisionalQuery ***
async function handleProvisionalQuery(request, env) {
  const url = new URL(request.url);
  const input = (url.searchParams.get("q") || "").trim();
  const limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (input && input.length > 100) {
    return new Response(JSON.stringify({ error: "query too long" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  const results = await queryProvisionals(env, { query: input, limit });
  return new Response(JSON.stringify({ success: true, results }), {
    status: 200,
    headers: CORS_HEADERS
  });
}
__name(handleProvisionalQuery, "handleProvisionalQuery");

async function handleProvisionalRestore(request, env) {
  if (!env.TBACKED) {
    return new Response(JSON.stringify({ error: "no_archive_bucket" }), {
      status: 503,
      headers: CORS_HEADERS
    });
  }
  const out = await restoreProvisionals(env);
  await logEvent(env, "provisional_restored", out);
  return new Response(JSON.stringify({ success: true, ...out }), {
    status: 200,
    headers: CORS_HEADERS
  });
}
__name(handleProvisionalRestore, "handleProvisionalRestore");

async function handleArchiveStatus(env) {
  if (!env.TBACKED) {
    return new Response(JSON.stringify({ error: "no_archive_bucket" }), { status: 503, headers: CORS_HEADERS });
  }
  const counts = {};
  const sample = [];
  let total = 0;
  let cursor;
  do {
    const page = await env.TBACKED.list({ prefix: ARCHIVE_PREFIX, limit: 500, cursor });
    cursor = page.truncated ? page.cursor : void 0;
    for (const obj of page.objects || []) {
      total++;
      const layer = obj.key.split("/")[1] || "unknown";
      counts[layer] = (counts[layer] || 0) + 1;
      if (sample.length < 8) sample.push({ key: obj.key, size: obj.size });
    }
  } while (cursor);
  return new Response(JSON.stringify({ success: true, total, counts, sample }), {
    status: 200, headers: CORS_HEADERS
  });
}
__name(handleArchiveStatus, "handleArchiveStatus");

async function handlePromote(request, env) {
  const body = await request.json().catch(() => ({}));
  const idOrInput = body.id || body.input;
  if (!idOrInput) {
    return new Response(JSON.stringify({ error: "id or input required" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  const prov = await getProvisional(env, idOrInput);
  if (!prov || !prov.answer) {
    return new Response(
      JSON.stringify({ error: "No provisional truth to promote" }),
      { status: 404, headers: CORS_HEADERS }
    );
  }
  const record = await setMaster(env, {
    query: prov.query || idOrInput,
    answer: prov.answer,
    editor: body.editor || "justice",
    meta: {
      literalVsMythos: body.literalVsMythos || "literal",
      model: body.model || prov.model || "justice-approved",
      confidence: body.confidence,
      eitlVerifier:
        body.eitlVerifier || body.editor || "justice",
      metadata: {
        ...(prov.metadata || {}),
        citations: prov.citations || [],
        promotedFrom: prov.id
      }
    }
  });
  await deleteProvisional(env, prov.id);
  await logEvent(env, "provisional_promoted", {
    id: record.id,
    layer: "master",
    from: prov.id
  });
  const resp = canonicalResponse({
    status: "ok",
    layer: "master",
    id: record.id,
    query: record.query,
    answer: record.answer,
    source: "master_truth",
    verified: true,
    provisional: false,
    eitl: {
      verifier: record.eitlVerifier || "justice",
      last_editor: record.editor || "justice"
    },
    meta: {
      literalVsMythos: record.literalVsMythos,
      model: record.model,
      confidence: clampMasterConfidence(
        record.confidence
      ),
      citations:
        (record.metadata && record.metadata.citations) || [],
      created: record.created,
      updated: record.updated,
      qc_passed: true
    }
  });
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: CORS_HEADERS
  });
}
__name(handlePromote, "handlePromote");

// countKeys: KV list() returns one page; walk the cursor for a real total.
// A prefix is required for honest numbers: MASTER_TRUTHS also holds review:* keys
// (nothing reads them) and Memoria holds memory, candidates, answers and budget rows
// beside the provisional ones. Counting whole namespaces overstates every layer.
async function countKeys(kv, prefix) {
  let total = 0;
  let cursor;
  for (let page = 0; page < 50; page++) {
    const opts = prefix ? { prefix } : {};
    if (cursor) opts.cursor = cursor;
    const res = await kv.list(opts);
    total += res.keys.length;
    if (res.list_complete || !res.cursor || !res.keys.length) break;
    cursor = res.cursor;
  }
  return total;
}
__name(countKeys, "countKeys");

async function handleKVStatus(env) {
  try {
    const [masterCount, provisionalCount, memoryCount, candidateCount, reviewCount] = await Promise.all([
      countKeys(env.MASTER_TRUTHS, KV_PREFIX_MASTER),
      countKeys(env.PROV_TRUTH, KV_PREFIX_PROV),
      countKeys(env.PROV_TRUTH, "truth:"),
      countKeys(env.PROV_TRUTH, "candidate:"),
      countKeys(env.MASTER_TRUTHS, "review:")
    ]);
    return new Response(
      JSON.stringify({
        masterCount,
        provisionalCount,
        memoryCount,
        candidateCount,
        reviewCount,
        namespaces: {
          masters: "master truths",
          memory: "Memoria"
        },
        proxyBound: !!env.PROXY,
        adminGated: !!env.ADMIN_KEY
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || String(err) }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
__name(handleKVStatus, "handleKVStatus");

// QCLogger unchanged, all ts are numbers
var QCLogger = class {
  static {
    __name(this, "QCLogger");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/log") && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { type, ts, ...rest } = body || {};
      if (!type) {
        return new Response(
          JSON.stringify({ error: "type required" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      const now = typeof ts === 'number' ? ts : Date.now();
      const event = { type, ts: now, ...rest };
      const existing =
        (await this.state.storage.get("events")) || [];
      existing.push(event);
      if (existing.length > 1e3) {
        existing.splice(0, existing.length - 1e3);
      }
      await this.state.storage.put("events", existing);

      if (this.env.TBACKED) {
        try {
          const day = new Date(now).toISOString().slice(0, 10);
          const key = `qc-events/${day}.jsonl`;
          const line = JSON.stringify(event) + "\n";
          const existingObj = await this.env.TBACKED.head(
            key
          );
          if (existingObj) {
            const old = await this.env.TBACKED.get(key);
            const oldText = await old.text();
            await this.env.TBACKED.put(key, oldText + line);
          } else {
            await this.env.TBACKED.put(key, line);
          }
        } catch (e) {
          console.warn(
            "QCLogger R2 write failed:",
            e && e.message
              ? e.message
              : String(e)
          );
        }
      }

      return new Response(
        JSON.stringify({ success: true }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (path.endsWith("/events") && request.method === "GET") {
      const events =
        (await this.state.storage.get("events")) || [];
      return new Response(
        JSON.stringify({ events }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response("Not found", { status: 404 });
  }
};

var worker_default = truthHandler;
export { QCLogger, worker_default as default };
