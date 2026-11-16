var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var CONFIG = {
  OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
  DECISIONS_URL: "https://openrouter.ai/api/alpha/decisions",
  EMBEDDING_URL: "https://openrouter.ai/api/v1/embeddings",
  // No model identifiers live here. The slugs come from the Worker's vars —
  // AI_MODEL, AI_EMBED_MODEL, EMBEDDING_MODEL — and nothing is baked in.
  WORKSPACE_URL: "https://truth-engine-workspace.ai-n.workers.dev",
  MIND_URL: "https://mind.ai-n.workers.dev",
  SITE_URL: "https://ai-nspired.com",
  SITE_TITLE: "AI-NSPIRED Truth Proxy",
  ADMIN_HEADER: "X-Admin-Secret",
  MAX_TEXT: 8e3,
  KB_RESULTS: 5,
  KB_SCAN: 120,
  KB_TTL: 6e4,
};
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Secret, x-admin-key",
  "Access-Control-Max-Age": "86400"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(json, "json");
function fail(status, code, extra) {
  return json({ error: code, ...extra || {} }, status);
}
__name(fail, "fail");
function secretOk(env, request) {
  // Fail closed. An unset secret must never read back as "authorised": the
  // previous `return true` made /api/admin/* depend on the caller-visible
  // 503 guard in handleAdmin for its only protection.
  if (!env.ADMIN_SECRET) return false;
  const given = request.headers.get(CONFIG.ADMIN_HEADER) || "";
  if (given.length !== env.ADMIN_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ env.ADMIN_SECRET.charCodeAt(i);
  }
  return diff === 0;
}
__name(secretOk, "secretOk");
async function listKeys(kv, prefix, limit) {
  const out = [];
  let cursor;
  while (out.length < limit) {
    const page = await kv.list({
      prefix,
      limit: Math.min(1e3, limit - out.length),
      ...cursor ? { cursor } : {}
    });
    out.push(...page.keys);
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out.slice(0, limit);
}
__name(listKeys, "listKeys");
async function readJson(kv, key) {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  return safeParse(raw);
}
__name(readJson, "readJson");
function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
__name(safeParse, "safeParse");
function tokens(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2).slice(0, 40);
}
__name(tokens, "tokens");
function score(queryTokens, text) {
  if (!queryTokens.length) return 0;
  const hay = String(text || "").toLowerCase();
  let hits = 0;
  for (const t of queryTokens) if (hay.includes(t)) hits++;
  return hits / queryTokens.length;
}
__name(score, "score");
function entryText(rec) {
  if (!rec) return "";
  if (typeof rec === "string") return rec;
  return [rec.answer, rec.content, rec.text, rec.title, rec.canonical].filter((v) => typeof v === "string").join("\n").slice(0, CONFIG.MAX_TEXT);
}
__name(entryText, "entryText");
var kbCache = { at: 0, layers: null };
async function loadLayer(kv, prefix, cap) {
  if (!kv) return [];
  const rows = [];
  try {
    const keys = await listKeys(kv, prefix, cap);
    for (let i = 0; i < keys.length; i += 25) {
      const chunk = keys.slice(i, i + 25);
      const values = await Promise.all(chunk.map((k) => kv.get(k.name).catch(() => null)));
      chunk.forEach((k, j) => {
        const text = entryText(safeParse(values[j]));
        if (text) rows.push({ label: k.name.slice(prefix.length), text });
      });
    }
  } catch (e) {
    console.error("[ai-proxy] layer load failed", prefix, e.message);
  }
  return rows;
}
__name(loadLayer, "loadLayer");
async function knowledgeBase(env) {
  const now = Date.now();
  if (kbCache.layers && now - kbCache.at < CONFIG.KB_TTL) return kbCache.layers;
  const [master, memory, knowledge] = await Promise.all([
    loadLayer(env.MASTER_TRUTHS, "master:", CONFIG.KB_SCAN),
    loadLayer(env.MEM, "truth:", CONFIG.KB_SCAN),
    loadLayer(env.ORP, "elevated:", CONFIG.KB_SCAN)
  ]);
  kbCache = { at: now, layers: { master, memory, knowledge } };
  console.log("[ai-proxy] kb loaded", master.length, memory.length, knowledge.length);
  return kbCache.layers;
}
__name(knowledgeBase, "knowledgeBase");
async function retrieve(query, env, limit = CONFIG.KB_RESULTS) {
  const qt = tokens(query);
  if (!qt.length) return [];
  const layers = await knowledgeBase(env);
  const results = [];
  for (const [layer, rows] of Object.entries(layers)) {
    for (const row of rows) {
      const s = score(qt, `${row.label} ${row.text}`);
      if (s > 0.2) results.push({ layer, label: row.label, content: row.text, score: s });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
__name(retrieve, "retrieve");
function contextBlock(hits) {
  if (!hits.length) return null;
  const body = hits.map((h) => `[${h.layer.toUpperCase()}: ${h.label}]
${h.content.slice(0, 900)}`).join("\n\n---\n\n");
  return {
    role: "system",
    content: `The following entries come from this system's own stores. They are reference material, not authority, and some are unverified, machine-generated, or previously wrong. Use them only to orient your answer. Do not restate any claim about a named person's legal or custodial status from these entries as fact; if an entry asserts such a thing, treat it as an unverified claim and say the record does not establish it, rather than repeating it. Prefer entries marked master and verified over memory. If the entries do not cover the question, say so and answer generally.

${body}`
  };
}
__name(contextBlock, "contextBlock");
async function aiText(messages, env, opts = {}) {
  if (!env.AI) throw new Error("AI binding missing");
  const model = cfModel(env, opts.model);
  if (!model) throw new Error("ai_model_required: send an @cf/ model or set AI_MODEL");
  const out = await env.AI.run(model, {
    messages,
    max_tokens: opts.max_tokens || 1024,
    temperature: opts.temperature ?? 0.3
  });
  const text = typeof out === "string" && out || out?.response || out?.choices?.[0]?.message?.content || out?.result?.response || "";
  if (!text) throw new Error("empty model response");
  return { text, model, route: "workers-ai" };
}
__name(aiText, "aiText");
async function orText(messages, env, opts = {}) {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");
  const model = orModel(env, opts.model);
  if (!model) throw new Error("openrouter_model_required: send model or set OPENROUTER_MODEL");
  const res = await fetch(CONFIG.OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.api_key || env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": CONFIG.SITE_URL,
      "X-Title": CONFIG.SITE_TITLE
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: opts.max_tokens || 1024,
      temperature: opts.temperature ?? 0.3
    })
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("empty OpenRouter response");
  return { text, model: data?.model || model, route: "openrouter" };
}
__name(orText, "orText");
async function mindText(messages, env) {
  const res = await fetch(`${CONFIG.MIND_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, stream: false }),
    signal: AbortSignal.timeout(45e3)
  });
  if (!res.ok) throw new Error(`mind error: ${res.status}`);
  const data = await res.json();
  const text = data.text || data.response || data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("empty mind response");
  return { text, model: data.model || "mind", route: "mind" };
}
__name(mindText, "mindText");
async function complete(messages, env, opts = {}) {
  const errors = [];
  for (const attempt of [aiText, orText, mindText]) {
    try {
      return await attempt(messages, env, opts);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(" | "));
}
__name(complete, "complete");
function toOpenAISSE(stream, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.response ?? parsed.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ model, choices: [{ delta: { content: delta } }] })}

`
                )
              );
            }
          } catch {
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    })
  );
}
__name(toOpenAISSE, "toOpenAISSE");
async function streamChat(messages, env, opts = {}) {
  const orTarget = orModel(env, opts.model);
  if (env.OPENROUTER_API_KEY && orTarget && opts.preferOpenRouter) {
    const res = await fetch(CONFIG.OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": CONFIG.SITE_URL,
        "X-Title": CONFIG.SITE_TITLE
      },
      body: JSON.stringify({ model: orTarget, messages, stream: true, temperature: opts.temperature ?? 0.3 })
    });
    if (res.ok && res.body) return res.body;
    if (opts.strictOpenRouter) throw new Error(`openrouter_${res.status}`);
  }
  if (!env.AI) throw new Error("AI binding missing");
  const mdl = cfModel(env, opts.model);
  if (!mdl) throw new Error("ai_model_required: send an @cf/ model or set AI_MODEL");
  const raw = await env.AI.run(mdl, {
    messages,
    stream: true,
    max_tokens: opts.max_tokens || 1024,
    temperature: opts.temperature ?? 0.3
  });
  return toOpenAISSE(raw, mdl);
}
__name(streamChat, "streamChat");
function sse(body) {
  return new Response(body, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
  });
}
__name(sse, "sse");
async function embed(text, env) {
  const input = String(text || "").slice(0, CONFIG.MAX_TEXT);
  if (!input) throw new Error("text required");
  if (env.OPENROUTER_API_KEY && env.EMBEDDING_MODEL) {
    try {
      const res = await fetch(CONFIG.EMBEDDING_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: env.EMBEDDING_MODEL, input })
      });
      if (res.ok) {
        const data = await res.json();
        const vec = data?.data?.[0]?.embedding;
        if (Array.isArray(vec) && vec.length) return vec;
      }
    } catch (e) {
      console.error("[ai-proxy] openrouter embed failed:", e.message);
    }
  }
  if (env.AI && env.AI_EMBED_MODEL) {
    const out = await env.AI.run(env.AI_EMBED_MODEL, { text: [input] });
    const vec = out?.data?.[0];
    if (Array.isArray(vec) && vec.length) return vec;
  }
  throw new Error("embedding unavailable");
}
__name(embed, "embed");
async function elevatedIndex(env) {
  return await readJson(env.ORP, "elevated:index") || [];
}
__name(elevatedIndex, "elevatedIndex");
async function putKnowledge(entry, env) {
  const id = entry.id || `elv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const prior = await readJson(env.ORP, `elevated:${id}`);
  const record = {
    id,
    title: entry.title || "Untitled",
    content: entry.content || "",
    domains: entry.domains || ["general"],
    confidence: Math.min(Number(entry.confidence) || 0.65, 0.8),
    source: entry.source || "auto",
    embedding: entry.embedding || prior && prior.embedding || [],
    createdAt: prior && prior.createdAt || now,
    updatedAt: now
  };
  await env.ORP.put(`elevated:${id}`, JSON.stringify(record));
  const index = await elevatedIndex(env);
  const summary = { id, title: record.title, domains: record.domains, confidence: record.confidence, createdAt: record.createdAt };
  const at = index.findIndex((e) => e.id === id);
  if (at >= 0) index[at] = summary;
  else index.push(summary);
  await env.ORP.put("elevated:index", JSON.stringify(index));
  kbCache = { at: 0, layers: null };
  return record;
}
__name(putKnowledge, "putKnowledge");
async function containmentOn(env, flag) {
  try {
    const v = await env.ORP.get("containment:" + flag);
    return v !== null && v !== "" && v !== "false";
  } catch (e) {
    return false;
  }
}
__name(containmentOn, "containmentOn");
async function learnFromAnswer(query, answer, source, env) {
  if (await containmentOn(env, "learning")) return null;
  if (!answer || answer.length < 40) return null;
  try {
    const embedding = await embed(`${query}

${answer}`, env).catch(() => []);
    return await putKnowledge(
      {
        title: `[${source}] ${String(query).slice(0, 120)}`,
        content: String(answer).slice(0, CONFIG.MAX_TEXT),
        domains: ["legal"],
        confidence: 0.78,
        source: "auto",
        embedding
      },
      env
    );
  } catch (e) {
    console.error("[ai-proxy] learn failed:", e.message);
    return null;
  }
}
__name(learnFromAnswer, "learnFromAnswer");
async function handleChat(request, env, runtime) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json");
  }
  const text = typeof body.message === "string" ? body.message : "";
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  if (!messages.length && text) messages = [{ role: "user", content: text }];
  if (!messages.length) return fail(400, "missing_message", { hint: "send {message} or {messages:[{role,content}]}" });
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const hits = lastUser ? await retrieve(lastUser.content, env) : [];
  const ctx = contextBlock(hits);
  if (ctx) messages.unshift(ctx);
  const opts = {
    model: body.model || body.preset,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    api_key: body.api_key,
    preferOpenRouter: body.provider === "openrouter"
  };
  if (body.stream) {
    try {
      return sse(await streamChat(messages, env, opts));
    } catch (e) {
      return fail(502, "model_failed", { message: e.message });
    }
  }
  try {
    const out = await complete(messages, env, opts);
    if (lastUser) runtime.waitUntil(learnFromAnswer(lastUser.content, out.text, "Chat", env).catch(() => {
    }));
    return json({ text: out.text, route: out.route, model: out.model, context: hits.length });
  } catch (e) {
    return fail(502, "model_failed", { message: e.message });
  }
}
__name(handleChat, "handleChat");
async function handleCandidate(request, env) {
  if (await containmentOn(env, "generation")) return fail(503, "generation_suspended", { reason: "containment" });
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json");
  }
  const query = body.query || body.input || body.prompt;
  const id = body.id || "";
  if (!query) return fail(400, "missing_query", { id });
  const hits = await retrieve(query, env);
  const ctx = contextBlock(hits);
  const instruction = body.instruction || "You are a backend JSON generator producing candidate reference answers for a legal-information system. Return ONLY a valid JSON array matching the JSON Schema. No prose, no markdown, no extra keys. Ground every statement in the provided material: if the material does not establish a fact, do not assert it. Never state or imply that a named person is wanted, a fugitive, at large, subject to an active warrant, or has failed to appear unless the source text says so in those words. Never propose surveillance, monitoring, tracking, or apprehension of any person. Treat provided context as unverified reference material that may contain errors.";
  const messages = [];
  if (ctx) messages.push(ctx);
  messages.push({
    role: "system",
    content: instruction + '\nRespond with a JSON array like [{"answer":"...","model":"...","confidence":0.7,"citations":[]}]. No code fences. No commentary. One to three elements.'
  });
  messages.push({ role: "user", content: String(query) });
  let lastErr = "no_attempt";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await complete(messages, env, { model: body.model, temperature: 0.2, max_tokens: 700 });
      const arr = extractJsonArray(out.text);
      if (arr && arr.length) {
        const cleaned = arr.filter((c) => c && typeof c.answer === "string" && c.answer.trim()).map((c) => ({
          answer: c.answer.trim(),
          model: out.model,
          // the model's self-report is unreliable (it echoes context labels)
          confidence: typeof c.confidence === "number" ? c.confidence : 0.7,
          citations: Array.isArray(c.citations) ? c.citations : []
        })).slice(0, 3);
        if (cleaned.length) return json(cleaned);
      }
      lastErr = "NO_CANDIDATE";
      messages.push({ role: "user", content: "That was not a bare JSON array. Return only the array, nothing else." });
    } catch (e) {
      lastErr = e.message;
      break;
    }
  }
  return fail(502, "no_candidate", { message: lastErr, id, context: hits.length });
}
__name(handleCandidate, "handleCandidate");
function extractJsonArray(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}
__name(extractJsonArray, "extractJsonArray");
async function handleGenerate(request, env, runtime) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json");
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  const prompt = body.prompt || messages.filter((m) => m.role === "user").pop()?.content || "";
  if (!messages.length && !prompt) return fail(400, "missing_prompt");
  if (!messages.length) messages.push({ role: "user", content: prompt });
  const hits = prompt ? await retrieve(prompt, env) : [];
  const ctx = contextBlock(hits);
  if (ctx) messages.unshift(ctx);
  const opts = {
    model: body.model || body.preset,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    api_key: body.api_key,
    preferOpenRouter: !!body.api_key
  };
  if (body.stream) {
    try {
      return sse(await streamChat(messages, env, opts));
    } catch (e) {
      return fail(502, "model_failed", { message: e.message });
    }
  }
  try {
    const out = await complete(messages, env, opts);
    if (prompt) runtime.waitUntil(learnFromAnswer(prompt, out.text, "Query", env).catch(() => {
    }));
    return json({
      choices: [{ message: { role: "assistant", content: out.text } }],
      text: out.text,
      model: out.model,
      route: out.route,
      context: hits.length
    });
  } catch (e) {
    return fail(502, "model_failed", { message: e.message });
  }
}
__name(handleGenerate, "handleGenerate");
async function handleCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json");
  }
  const prompt = body.prompt || body.message || body.code;
  if (!prompt) return fail(400, "missing_prompt");
  const messages = [
    { role: "system", content: "You are a precise coding assistant. Return code first, then a short explanation. No filler." },
    { role: "user", content: String(prompt) }
  ];
  try {
    const out = await complete(messages, env, { model: body.model, temperature: 0.2, max_tokens: body.max_tokens || 1200 });
    return json({ text: out.text, model: out.model, route: out.route });
  } catch (e) {
    return fail(502, "model_failed", { message: e.message });
  }
}
__name(handleCode, "handleCode");

async function handleAdmin(request, env, url) {
  if (!env.ADMIN_SECRET) return fail(503, "admin_not_configured", { hint: "set the ADMIN_SECRET secret" });
  if (!secretOk(env, request)) return fail(401, "unauthorized");
  const path = url.pathname.replace("/api/admin", "");
  if (path === "/stats" || path === "" || path === "/") {
    const counts = {};
    for (const [label, kv, prefix] of [
      ["master", env.MASTER_TRUTHS, "master:"],
      ["memory", env.MEM, "truth:"],
      ["provisional", env.MEM, "provisional:"],
      ["knowledge", env.ORP, "elevated:"]
    ]) {
      try {
        counts[label] = (await listKeys(kv, prefix, 5e3)).length;
      } catch {
        counts[label] = null;
      }
    }
    return json({ counts, bindings: bindingReport(env) });
  }
  if (path === "/knowledge" && request.method === "GET") {
    return json({ entries: await elevatedIndex(env) });
  }
  if (path === "/knowledge" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.content) return fail(400, "content_required");
    const embedding = await embed(body.content, env).catch(() => []);
    const entry = await putKnowledge({ ...body, source: "admin", embedding }, env);
    return json({ success: true, entry });
  }
  if (path === "/knowledge/search" && request.method === "GET") {
    const q = url.searchParams.get("q");
    if (!q) return fail(400, "q_required");
    return json({ results: await retrieve(q, env, 10) });
  }
  if (path.startsWith("/knowledge/") && request.method === "GET") {
    const entry = await readJson(env.ORP, `elevated:${path.split("/").pop()}`);
    return entry ? json(entry) : fail(404, "not_found");
  }
  if (path.startsWith("/knowledge/") && request.method === "PUT") {
    const id = path.split("/").pop();
    const prior = await readJson(env.ORP, `elevated:${id}`);
    if (!prior) return fail(404, "not_found");
    const body = await request.json().catch(() => ({}));
    const embedding = body.content && body.content !== prior.content ? await embed(body.content, env).catch(() => prior.embedding) : prior.embedding;
    const entry = await putKnowledge({ ...prior, ...body, id, embedding }, env);
    return json({ success: true, entry });
  }
  if (path.startsWith("/knowledge/") && request.method === "DELETE") {
    const id = path.split("/").pop();
    await env.ORP.delete(`elevated:${id}`);
    const index = (await elevatedIndex(env)).filter((e) => e.id !== id);
    await env.ORP.put("elevated:index", JSON.stringify(index));
    return json({ success: true });
  }
  return fail(404, "not_found");
}
__name(handleAdmin, "handleAdmin");
function bindingReport(env) {
  return {
    master: !!env.MASTER_TRUTHS,
    memoria: !!env.MEM,
    audits: !!env.AUDITS,
    context: !!env.CONTEXT_STORE,
    knowledge: !!env.ORP,
    r2: !!env.TRUTH_BUCKET,
    d1: !!env.CHAT_DB,
    truth: !!env.TRUTH,
    ai: !!env.AI,
    openrouter: !!env.OPENROUTER_API_KEY,
    adminSecret: !!env.ADMIN_SECRET,
    truthKey: !!env.TRUTH_ADMIN_KEY
  };
}
__name(bindingReport, "bindingReport");
// --- model namespace policy -------------------------------------------------
// Two disjoint namespaces share this proxy: Workers AI slugs start with @cf/,
// every other model name belongs to OpenRouter. Mixing them is what produced
// `5007: No such model ... or task` on the AI binding, and an empty OpenRouter
// response on the way back out.
const isCfModel = (m) => typeof m === "string" && m.startsWith("@cf/");
const cfModel = (env, m) => (isCfModel(m) ? m : env.AI_MODEL || null);
const orModel = (env, m) => (typeof m === "string" && m && !isCfModel(m) ? m : env.OPENROUTER_MODEL || null);

// --- containment visibility -------------------------------------------------
async function containmentState(env) {
  try {
    return {
      generation: await containmentOn(env, "generation"),
      learning: await containmentOn(env, "learning")
    };
  } catch {
    return { generation: null, learning: null };
  }
}

// --- rate limiting ----------------------------------------------------------
// Uses the RATE_LIMITER binding when the script has one and ignores it when it
// does not. A limiter error must never take the proxy down, so this fails open
// and only a definite `success: false` rejects the request.
async function rateLimit(env, request) {
  const rl = env.RATE_LIMITER;
  if (!rl || typeof rl.limit !== "function") return null;
  try {
    const key = request.headers.get("cf-connecting-ip") || "anonymous";
    const out = await rl.limit({ key });
    if (!out || out.success !== false) return null;
    return fail(429, "rate_limited", { message: "Too many requests. Slow down and retry." });
  } catch {
    return null;
  }
}

// --- OpenAI-compatible surface ---------------------------------------------
// POST /chat/completions and /v1/chat/completions behave like the real thing,
// so an OpenAI client - or a caller that only knows the standard path - works
// against this proxy. A caller-supplied model is tried on OpenRouter first,
// because a name like gpt-4o-mini is meaningless to Workers AI.
async function handleOpenAI(request, env, runtime) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json");
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  if (!messages.length) return fail(400, "messages_required");
  if (typeof body.model !== "string" || !body.model) {
    return fail(400, "model_required", { message: "Send model, e.g. openai/gpt-4o-mini." });
  }
  const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
  const prompt = lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
  const hits = prompt ? await retrieve(prompt, env) : [];
  const ctx = contextBlock(hits);
  if (ctx) messages.unshift(ctx);
  const opts = {
    model: body.model,
    max_tokens: body.max_tokens || body.max_completion_tokens,
    temperature: body.temperature,
    preferOpenRouter: true
  };
  const id = "chatcmpl-" + crypto.randomUUID();
  if (body.stream) {
    try {
      return sse(await streamChat(messages, env, opts));
    } catch (e) {
      return fail(502, "model_failed", { message: e.message });
    }
  }
  try {
    const out = await orText(messages, env, opts).catch(() => complete(messages, env, opts));
    if (prompt) runtime.waitUntil(learnFromAnswer(prompt, out.text, "OpenAI", env).catch(() => {}));
    return json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1e3),
      model: out.model,
      choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" }],
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
      route: out.route
    });
  } catch (e) {
    return fail(502, "model_failed", { message: e.message });
  }
}

// --- decision models ---------------------------------------------------------
// The Decisions API is not a chat completion: one forward pass over `state`
// returns a typed answer per question, and output is a token or two. Cost is
// input tokens x price, charged once per pass, so the lever is batching
// questions, not compressing input.
const DECIDERS = {
  flash: { model: "perplexity/pplx-decider-flash-v1.2", window: 262144, price: 0.01 },
  joint: { model: "perplexity/pplx-decider-v1.2", window: 262144, price: 0.02 },
  doc: { model: "scaledown/classify-1", window: 1000000, price: 0.04 }
};

function hasMedia(state) {
  const parts = Array.isArray(state) ? state : [state];
  return parts.some(
    (p) => p && typeof p === "object" && ["image_url", "input_audio", "video_url"].includes(p.type)
  );
}

// A deliberate upper estimate. Text is counted at 4 characters per token and
// each media part is charged a flat amount, because its real tokenisation is not
// visible from here. Overestimating is the safe direction: it escalates early
// rather than sending a state that will be rejected.
function estimateTokens(state) {
  const parts = Array.isArray(state) ? state : [state];
  let text = "";
  let media = 0;
  for (const part of parts) {
    if (typeof part === "string") text += part;
    else if (part && typeof part === "object" && ["image_url", "input_audio", "video_url"].includes(part.type)) media++;
    else text += JSON.stringify(part || "");
  }
  return Math.ceil(text.length / 4) + media * 1600;
}

// flash: one question. joint: several, answered together for one state charge.
// doc: media or a state too large for the 262K window.
function pickDecider(stateTokens, questionCount, media) {
  if (media) return { key: "doc", reason: "media" };
  if (stateTokens > DECIDERS.joint.window) return { key: "doc", reason: "size" };
  if (questionCount > 1) return { key: "joint", reason: "questions" };
  return { key: "flash", reason: "single" };
}

async function decide(state, questions, env, opts = {}) {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");
  if (!state) throw new Error("state_required");
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) throw new Error("questions_required");
  const names = Object.keys(questions);
  if (!names.length) throw new Error("questions_required");

  const media = hasMedia(state);
  const tokens = estimateTokens(state);
  const choice = opts.model
    ? { key: "custom", reason: "caller" }
    : pickDecider(tokens, names.length, media);
  const key = choice.key;
  const model = opts.model || DECIDERS[key].model;
  const escalated = choice.reason === "size";

  // Never truncate. If the state cannot fit the largest window there is, say so:
  // a cut-down state produces a confident answer about the wrong input.
  if (!opts.model && tokens > DECIDERS.doc.window) {
    const err = new Error("state_too_large: about " + tokens + " tokens exceeds " + DECIDERS.doc.model + " (" + DECIDERS.doc.window + ")");
    err.code = "state_too_large";
    throw err;
  }

  const res = await fetch(CONFIG.DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": CONFIG.SITE_URL,
      "X-Title": CONFIG.SITE_TITLE
    },
    body: JSON.stringify({ model, state, questions })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error("decisions_" + res.status + ": " + String(detail).slice(0, 300));
    err.code = "decisions_" + res.status;
    throw err;
  }

  const data = await res.json();
  const raw = data && data.answers && typeof data.answers === "object" ? data.answers : {};

  // A refusal is not an answer. Normalise it so no caller can read one as a
  // negative, or as a safe verdict, by accident.
  const answers = {};
  for (const name of Object.keys(raw)) {
    const a = raw[name];
    if (!a || a.type === "refusal") answers[name] = { type: "refusal", answered: false };
    else answers[name] = Object.assign({}, a, { answered: true });
  }

  return {
    model: data.model || model,
    provider: data.provider || null,
    answers,
    usage: data.usage || null,
    pick: { key, reason: choice.reason, escalated, estimated_tokens: tokens, questions: names.length, media }
  };
}

async function handleDecide(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json");
  }
  try {
    return json(await decide(body.state, body.questions, env, { model: body.model }));
  } catch (e) {
    if (e.code === "state_too_large") return fail(413, "state_too_large", { message: e.message });
    if (String(e.message).startsWith("decisions_")) return fail(502, "decisions_failed", { message: e.message });
    return fail(400, "bad_request", { message: e.message });
  }
}

// The presets this proxy will call. A preset carries its own prompt, model and
// parameters; the proxy only names them. truth is first because it is the one the
// legal paths call, and the rest are published alongside it so a client can offer
// them without hardcoding a list of its own.
const PRESETS = [
  { id: "truth", name: "Truth" },
  { id: "doc", name: "Document" },
  { id: "micro", name: "Micro" },
  { id: "mnl", name: "MNL" },
  { id: "operator", name: "Operator" }
];
const presetModel = (id) => "@preset/" + String(id || "").replace(/^@preset\//, "");

// The preset owns the prompt, the model and the parameters. This route supplies
// none of them: it hands the caller's messages to the preset and returns whatever
// comes back, stream or JSON. Nothing here knows what an audit looks like.
async function handleAudit(request, env) {
  if (!env.OPENROUTER_API_KEY) return fail(503, "openrouter_key_missing");
  // truth is the preset the audit calls. AUDIT_PRESET overrides it; the preset
  // still owns the prompt, so nothing about the audit lives in this file.
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) return fail(400, "messages_required");
  // The body goes as it arrived. The only fields removed are the two the page adds
  // that are not chat-completion parameters.
  const out = Object.assign({}, body, { model: presetModel(env.AUDIT_PRESET || "truth") });
  delete out.type;
  delete out.audit_id;

  const res = await fetch(CONFIG.OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": CONFIG.SITE_URL,
      "X-Title": CONFIG.SITE_TITLE
    },
    body: JSON.stringify(out)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return fail(502, "audit_failed", { status: res.status, message: String(detail).slice(0, 300) });
  }
  return new Response(res.body, {
    status: res.status,
    headers: { ...CORS, "Content-Type": res.headers.get("content-type") || "application/json" }
  });
}
__name(handleAudit, "handleAudit");

// --- audit record relay ------------------------------------------------------
// The page at i.nspired.cc gets an audit from /v1/audit, then asks for it to be
// kept. The record belongs to truth (R2, no expiry); this Worker only carries it
// there. Truth demands ADMIN_KEY on a write, so the key lives here as a secret
// and never reaches the browser.
async function handleAuditStore(request, env) {
  if (!env.TRUTH) return fail(503, "truth_not_bound");
  if (!env.TRUTH_ADMIN_KEY) {
    return fail(503, "truth_key_not_configured", {
      hint: "set the TRUTH_ADMIN_KEY secret to truth's ADMIN_KEY, then save again"
    });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return fail(400, "invalid_json");
  let res;
  try {
    res = await env.TRUTH.fetch("https://truth/api/truth/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": env.TRUTH_ADMIN_KEY },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return fail(502, "truth_unreachable", { message: e.message });
  }
  const text = await res.text();
  let stored = null;
  try { stored = JSON.parse(text); } catch { stored = null; }
  if (!res.ok || !stored || !stored.id) {
    return fail(res.ok ? 502 : res.status === 401 ? 502 : res.status, "audit_not_stored", {
      truth_status: res.status,
      message: (stored && (stored.error || stored.message)) || String(text).slice(0, 200)
    });
  }
  return json({ success: true, id: stored.id, audit_id: stored.id, stored: true, saved_at: stored.saved_at ?? null });
}
__name(handleAuditStore, "handleAuditStore");

async function handleAuditRecord(env, id) {
  if (!env.TRUTH) return fail(503, "truth_not_bound");
  let res;
  try {
    res = await env.TRUTH.fetch("https://truth/api/truth/audit/" + encodeURIComponent(id), { method: "GET" });
  } catch (e) {
    return fail(502, "truth_unreachable", { message: e.message });
  }
  const text = await res.text();
  if (res.status === 404) return fail(404, "audit_not_found", { message: "Nothing is stored under that id." });
  if (!res.ok) return fail(res.status, "audit_read_failed", { truth_status: res.status });
  return new Response(text, {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(handleAuditRecord, "handleAuditRecord");

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (p === "/" || p === "") {
      return new Response(
        `AI Proxy Service \u2014 single entry point

Endpoints:
  GET  /health
  POST /api/chat          {message|messages, stream}
  POST /api/generate      {prompt|messages, stream}
  POST /chat/completions  OpenAI-compatible {messages, model, stream}
  GET  /api/presets       the presets this proxy will call
  POST /api/decide        {state, questions, model?} -> typed answers + cost
  POST /v1/chat/completions
  POST /api/code          {prompt}
  POST /candidate         {id, query, model, instruction, schema} -> JSON array
  POST /api/embed         {text}
  POST /api/context       {context_id, message}
  POST /api/context/clear {context_id}
  GET  /api/elevated
  ANY  /api/admin/*       X-Admin-Secret

Knowledge stores: master truths + Memoria. Audits land in the curation queue.
`,
        { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
    try {
      if (p === "/health") {
        return json({
          status: "healthy",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          service: "ai-proxy",
          bindings: bindingReport(env),
          containment: await containmentState(env),
          retrieval: {
            masterTruths: env.MASTER_TRUTHS ? "904eff3a master truths" : null,
            memoria: env.MEM ? "4a9bfbff Memoria" : null,
            knowledge: env.ORP ? "145a30ed ORP" : null
          }
        });
      }
      if ((p === "/chat/completions" || p === "/v1/chat/completions") && request.method === "POST") {
        const limited = await rateLimit(env, request);
        if (limited) return limited;
        return handleOpenAI(request, env, ctx);
      }
      if (p === "/api/decide" && request.method === "POST") {
        const limited = await rateLimit(env, request);
        if (limited) return limited;
        return handleDecide(request, env);
      }
      if (p === "/api/presets" && request.method === "GET") {
        return json({ presets: PRESETS });
      }
      // The page at i-nspired.pages.dev reaches this through orproxy.
      if ((p === "/v1/audit" || p === "/audit") && request.method === "POST") {
        const limited = await rateLimit(env, request);
        if (limited) return limited;
        return handleAudit(request, env);
      }
      if ((p === "/v1/audit/store" || p === "/audit/store") && request.method === "POST") {
        const limitedStore = await rateLimit(env, request);
        if (limitedStore) return limitedStore;
        return handleAuditStore(request, env);
      }
      if (p.startsWith("/v1/audit/") && p !== "/v1/audit/store" && request.method === "GET") {
        return handleAuditRecord(env, decodeURIComponent(p.slice("/v1/audit/".length)));
      }
      if (p === "/api/chat" && request.method === "POST") return handleChat(request, env, ctx);
      if ((p === "/candidate" || p === "/api/candidate") && request.method === "POST") return handleCandidate(request, env);
      if (p === "/api/generate" && request.method === "POST") return handleGenerate(request, env, ctx);
      if (p === "/api/code" && request.method === "POST") return handleCode(request, env);
      if (p === "/api/mcp") {
        return fail(501, "mcp_not_implemented", {
          message: "The old dashboard build exposed MCP here and this repo build does not. Tell me what it needs and it comes back on this route."
        });
      }
      if (p === "/api/embed" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !body.text) return fail(400, "text_required");
        try {
          return json({ embedding: await embed(body.text, env) });
        } catch (e) {
          return fail(502, "embed_failed", { message: e.message });
        }
      }
      if (p === "/api/context" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !body.message) return fail(400, "message_required");
        const id = body.context_id || "default";
        const key = `ctx:${id}:data`;
        const prior = await readJson(env.CONTEXT_STORE, key) || [];
        const embedding = await embed(body.message, env).catch(() => []);
        prior.push({ role: body.role || "user", content: String(body.message).slice(0, CONFIG.MAX_TEXT), embedding, at: Date.now() });
        const trimmed = prior.slice(-100);
        await env.CONTEXT_STORE.put(key, JSON.stringify(trimmed));
        return json({ success: true, context_id: id, messages: trimmed.length });
      }
      if (p === "/api/context/clear" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        await env.CONTEXT_STORE.delete(`ctx:${body.context_id || "default"}:data`);
        return json({ success: true });
      }
      if (p === "/api/elevated" && request.method === "GET") {
        return json({ entries: await elevatedIndex(env) });
      }
      if (p === "/api/elevated/search" && request.method === "GET") {
        const q = url.searchParams.get("q");
        if (!q) return fail(400, "q_required");
        return json({ results: await retrieve(q, env, 10) });
      }
      if (p.startsWith("/api/admin/")) return handleAdmin(request, env, url);
      return fail(404, "not_found", {
        available_endpoints: ["/api/chat", "/api/code", "/api/generate", "/candidate", "/api/mcp", "/api/embed", "/api/context", "/api/elevated", "/api/admin/*", "/chat/completions", "/v1/chat/completions", "/api/decide", "/v1/audit", "/v1/audit/store", "/health", "/"]
      });
    } catch (e) {
      console.error("[ai-proxy] unhandled", p, e.stack || e.message);
      return fail(500, "internal_error", { message: e.message });
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
