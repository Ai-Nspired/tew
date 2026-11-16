// Offline test harness for the rebuilt ai-proxy.
//
// Imports the worker exactly as the dashboard will run it (a single ES module
// exporting `default.fetch`) and drives it with stubbed bindings, so every route
// can be exercised without touching the live script or the OpenRouter balance.
//
// Run: node rebuild/ai-proxy/test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "worker.js"), "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const worker = mod.default;

// --- stubs ------------------------------------------------------------------

function kv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _map: m
  };
}

const AI = {
  async run(model, opts = {}) {
    if (opts.text) return { data: [[0.1, 0.2, 0.3]] };
    const all = JSON.stringify(opts.messages || []);
    if (all.includes("JSON array")) {
      return { response: '[{"answer":"stub candidate answer","confidence":0.7,"citations":[]}]' };
    }
    return { response: `stub:${model}` };
  }
};

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("openrouter.ai/api/v1/chat/completions")) {
    globalThis.__orBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: JSON.parse(init.body).model,
      choices: [{ message: { role: "assistant", content: "or-stub" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("/api/alpha/decisions")) {
    const req = JSON.parse(init.body);
    (globalThis.__decisionCalls = globalThis.__decisionCalls || []).push({
      model: req.model,
      questions: Object.keys(req.questions || {}).length
    });
    return new Response(JSON.stringify({
      id: "gen-dec-test",
      model: req.model,
      provider: "test",
      answers: {
        intent: { type: "choice", choice: "audit", probabilities: { audit: 0.8, other: 0.2 }, confidence: 0.8 },
        flagged: { type: "refusal" }
      },
      usage: { input_tokens: 100, output_tokens: 1, cost: 0.000001 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("openrouter.ai/api/v1/embeddings")) {
    return new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.6] }] }), { status: 200 });
  }
  if (u.includes("mind.ai-n.workers.dev")) {
    return new Response(JSON.stringify({ text: "mind-stub" }), { status: 200 });
  }
  throw new Error("unstubbed fetch: " + u);
};

const ctx = { waitUntil(p) { if (p && p.catch) p.catch(() => {}); } };

function mkEnv(extra = {}) {
  return {
    AI,
    OPENROUTER_API_KEY: "test-key",
    AUDIT_PRESET: "@preset/truth",
    // Models are Worker vars. A deployed Worker sets them; so does the harness.
    AI_MODEL: "@cf/test/text-model",
    AI_EMBED_MODEL: "@cf/test/embed-model",
    EMBEDDING_MODEL: "test/embedding-model",
    ORP: kv(),
    MEM: kv(),
    MASTER_TRUTHS: kv(),
    AUDITS: kv(),
    CONTEXT_STORE: kv(),
    TRUTH_BUCKET: { async put() {}, async head() { return null; } },
    TRUTH: { async fetch() { return new Response(JSON.stringify({ ok: true }), { status: 200 }); } },
    ...extra
  };
}

async function hit(env, method, path, body, headers = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await worker.fetch(new Request("https://ai-proxy.test" + path, init), env, ctx);
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: res.status, payload };
}

// --- assertions -------------------------------------------------------------

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else {
    failures.push(name + (detail !== undefined ? " -> " + JSON.stringify(detail).slice(0, 240) : ""));
    console.log("  FAIL  " + name);
  }
}

console.log("ai-proxy rebuild: offline checks\n");

let r = await hit(mkEnv(), "GET", "/");
check("GET / serves the endpoint listing",
  r.status === 200 && String(r.payload).includes("/api/chat"), r.status);

r = await hit(mkEnv(), "GET", "/health");
check("GET /health reports healthy", r.status === 200 && r.payload.status === "healthy", r.payload);
check("/health exposes containment state",
  r.payload && r.payload.containment && r.payload.containment.generation === false,
  r.payload && r.payload.containment);
check("/health reports the truth binding",
  r.payload && r.payload.bindings && r.payload.bindings.truth === true);

// The path TEW calls through orproxy, which did not exist before.
r = await hit(mkEnv(), "POST", "/chat/completions", {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "hello" }]
});
check("POST /chat/completions returns OpenAI shape",
  r.status === 200 && r.payload.choices?.[0]?.message?.content === "or-stub", r.payload);
check("OpenAI route reports its upstream route",
  r.payload && r.payload.route === "openrouter", r.payload && r.payload.route);
check("OpenAI route returns an id and object",
  !!(r.payload && r.payload.id && r.payload.object === "chat.completion"));

r = await hit(mkEnv(), "POST", "/v1/chat/completions", {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "hello" }]
});
check("POST /v1/chat/completions works too",
  r.status === 200 && r.payload.choices?.[0]?.message?.content === "or-stub", r.status);

r = await hit(mkEnv(), "POST", "/api/chat", { message: "hello" });
check("POST /api/chat still works",
  r.status === 200 && typeof r.payload.text === "string", r.payload);

// The 5007 bug: an OpenRouter preset must never be handed to Workers AI.
r = await hit(mkEnv(), "POST", "/api/chat", { message: "hello", model: "@preset/truth" });
check("preset model is not passed to Workers AI",
  r.status === 200 && String(r.payload.text).startsWith("stub:@cf/"), r.payload);

// The audit route is a relay to the preset and carries no prompt of its own.
r = await hit(mkEnv(), "POST", "/v1/audit", { messages: [{ role: "user", content: "hello" }] });
check("the audit route calls the preset",
  r.status === 200 && r.payload.model === "@preset/truth", r.payload);
check("the caller's messages reach the preset untouched",
  JSON.stringify(globalThis.__orBody.messages) === JSON.stringify([{ role: "user", content: "hello" }]),
  globalThis.__orBody.messages);
// An audit is exactly the case where an instruction is needed. The relay does not
// invent one, and it does not strip one either: whatever the caller or the decision
// supplies goes through.
r = await hit(mkEnv(), "POST", "/v1/audit", {
  messages: [
    { role: "system", content: "read the record in full before answering" },
    { role: "user", content: "hello" }
  ]
});
check("a caller's own instruction survives the relay",
  r.status === 200 && globalThis.__orBody.messages[0].role === "system"
  && globalThis.__orBody.messages[0].content === "read the record in full before answering",
  globalThis.__orBody.messages);

r = await hit(mkEnv(), "POST", "/v1/audit", { text: "audit this" });
check("a body with no messages is refused, not reshaped",
  r.status === 400 && r.payload.error === "messages_required", r.payload);

r = await hit(mkEnv({ AUDIT_PRESET: undefined }), "POST", "/v1/audit", { messages: [{ role: "user", content: "x" }] });
check("the audit calls truth when no var overrides it",
  r.status === 200 && globalThis.__orBody.model === "@preset/truth", globalThis.__orBody.model);

// Presets are published and callable.
r = await hit(mkEnv(), "GET", "/api/presets");
check("the presets are listed, truth first",
  r.status === 200 && r.payload.presets[0].id === "truth" && r.payload.presets.length === 5, r.payload);

r = await hit(mkEnv(), "POST", "/chat/completions", {
  model: "@preset/doc", messages: [{ role: "user", content: "hi" }]
});
check("any published preset is callable as a model",
  r.status === 200 && globalThis.__orBody.model === "@preset/doc", globalThis.__orBody.model);

r = await hit(mkEnv({ AUDIT_PRESET: "@preset/other" }), "POST", "/v1/audit", { messages: [{ role: "user", content: "x" }] });
check("the preset is a var, not baked in", r.payload.model === "@preset/other", r.payload);

r = await hit(mkEnv({ OPENROUTER_API_KEY: undefined }), "POST", "/v1/audit", { text: "x" });
check("the relay says so when there is no key", r.status === 503, r.payload);

r = await hit(mkEnv(), "POST", "/v1/audit", { messages: [{ role: "user", content: "x" }], type: "docket", audit_id: "a1", stream: false });
check("page-only fields are dropped so the request is valid",
  !("type" in globalThis.__orBody) && !("audit_id" in globalThis.__orBody), Object.keys(globalThis.__orBody));
check("nothing else about the body is changed",
  JSON.stringify(globalThis.__orBody.messages) === JSON.stringify([{ role: "user", content: "x" }])
  && globalThis.__orBody.stream === false, globalThis.__orBody);

r = await hit(mkEnv(), "POST", "/candidate", { id: "t1", query: "what is a durable object" });
check("POST /candidate generates when containment is off",
  r.status === 200 && Array.isArray(r.payload) && r.payload[0].answer === "stub candidate answer", r.payload);

const contained = mkEnv({ ORP: kv({ "containment:generation": "1" }) });
r = await hit(contained, "POST", "/candidate", { id: "t1", query: "x" });
check("containment:generation still suspends /candidate",
  r.status === 503 && r.payload.error === "generation_suspended", r.payload);

r = await hit(contained, "GET", "/health");
check("/health shows generation contained", r.payload && r.payload.containment.generation === true);

r = await hit(mkEnv(), "POST", "/api/embed", { text: "hello" });
check("POST /api/embed returns a vector",
  r.status === 200 && Array.isArray(r.payload.embedding), r.status);

// Security: the old secretOk() returned true when no secret was configured.
r = await hit(mkEnv(), "GET", "/api/admin/stats");
check("admin is closed when ADMIN_SECRET is unset", r.status === 503, r.payload);

r = await hit(mkEnv({ ADMIN_SECRET: "s3cret" }), "GET", "/api/admin/stats");
check("admin rejects a missing header once a secret exists", r.status === 401, r.payload);

r = await hit(mkEnv({ ADMIN_SECRET: "s3cret" }), "GET", "/api/admin/stats",
  undefined, { "X-Admin-Secret": "s3cret" });
check("admin accepts the correct secret", r.status === 200 && r.payload.counts, r.payload);

// Rate limiting is optional and must fail open when it errors.
r = await hit(mkEnv({ RATE_LIMITER: { async limit() { return { success: false }; } } }),
  "POST", "/chat/completions", { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
check("RATE_LIMITER is honoured when present",
  r.status === 429 && r.payload.error === "rate_limited", r.payload);

r = await hit(mkEnv({ RATE_LIMITER: { async limit() { throw new Error("boom"); } } }),
  "POST", "/api/chat", { message: "hi" });
check("a failing limiter does not take the proxy down", r.status === 200, r.status);

r = await hit(mkEnv(), "GET", "/nope");
const advertised = (r.payload && r.payload.available_endpoints) || [];
check("unknown route lists the new endpoints",
  r.status === 404 && advertised.includes("/chat/completions"), r.payload);

// --- the audit surface: what stays gone, what came back ---------------------

// The generation route stays. The pipeline route never existed in this build.
const gone = await hit(mkEnv(), "POST", "/v1/pipeline", { content: "x" });
check("removed route /v1/pipeline returns 404", gone.status === 404, gone.status);

// Saving is back, but only as a relay to truth: with no key configured it
// refuses rather than pretending an audit was kept.
const unkeyed = await hit(mkEnv(), "POST", "/v1/audit/store", { content: "x" });
check("the store route exists and refuses without a truth key",
  unkeyed.status === 503 && unkeyed.payload.error === "truth_key_not_configured", unkeyed.payload);
check("hardcoded audit prompt is absent from the source", !source.includes("AUDIT_SYSTEM_PROMPT"));
check("evidentiary gate is absent from the source",
  !source.includes("NONASSERTION") && !source.includes("MSB26006196"));
check("payment handles are absent from the source",
  !source.includes("chime.me") && !source.includes("$AINspired"));
check("the audit endpoints are advertised", JSON.stringify(advertised).includes("/v1/audit/store"));
// The chat route must never substitute a preset for a missing model. The audit
// relay is the one place a preset is named, because that route exists to call it.
check("the source names presets only through presetModel",
  (source.match(/@preset\//g) || []).length === 1 && source.includes("env.AUDIT_PRESET"),
  (source.match(/@preset\//g) || []).length);

r = await hit(mkEnv(), "POST", "/chat/completions", {
  messages: [{ role: "user", content: "hi" }]
});
check("OpenAI route requires an explicit model",
  r.status === 400 && r.payload.error === "model_required", r.payload);

r = await hit(mkEnv({ OPENROUTER_MODEL: "openai/gpt-4o-mini" }), "POST", "/chat/completions", {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }]
});
check("a named model still reaches OpenRouter", r.status === 200 && r.payload.route === "openrouter", r.payload);

// --- decision models --------------------------------------------------------

const decCalls = () => globalThis.__decisionCalls || [];
globalThis.__decisionCalls = [];
const filler = (n) => "a ".repeat(Math.ceil(n / 2)).slice(0, n);

r = await hit(mkEnv(), "POST", "/api/decide", {
  state: "short message",
  questions: { intent: { type: "noul", instructions: "is this an audit?" } }
});
check("one question routes to flash",
  r.status === 200 && String(r.payload.model).includes("pplx-decider-flash-v1.2"), r.payload);
check("a refusal is normalised as not answered",
  r.payload.answers.flagged.answered === false && r.payload.answers.intent.answered === true, r.payload.answers);
check("the decision returns its own cost",
  r.payload.usage && typeof r.payload.usage.cost === "number", r.payload.usage);
check("the pick is reported for provenance",
  r.payload.pick && r.payload.pick.estimated_tokens > 0, r.payload.pick);

r = await hit(mkEnv(), "POST", "/api/decide", {
  state: "x",
  questions: {
    a: { type: "noul", instructions: "?" },
    b: { type: "noul", instructions: "?" },
    c: { type: "noul", instructions: "?" }
  }
});
check("several questions route to the 27B",
  r.status === 200 && String(r.payload.model).includes("pplx-decider-v1.2")
    && !String(r.payload.model).includes("flash"), r.payload);

r = await hit(mkEnv(), "POST", "/api/decide", {
  state: ["caption", { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
  questions: { q: { type: "noul", instructions: "?" } }
});
check("media routes to classify-1",
  r.status === 200 && r.payload.model === "scaledown/classify-1", r.payload);

r = await hit(mkEnv(), "POST", "/api/decide", {
  state: filler(1200000),
  questions: { q: { type: "noul", instructions: "?" } }
});
check("over the 262K window it escalates instead of truncating",
  r.status === 200 && r.payload.model === "scaledown/classify-1" && r.payload.pick.escalated === true,
  r.payload.pick);

const callsBefore = decCalls().length;
r = await hit(mkEnv(), "POST", "/api/decide", {
  state: filler(4200000),
  questions: { q: { type: "noul", instructions: "?" } }
});
check("over every window it fails loudly",
  r.status === 413 && r.payload.error === "state_too_large", r.payload);
check("nothing is sent when the state cannot fit", decCalls().length === callsBefore);

r = await hit(mkEnv(), "POST", "/api/decide", { state: "x", questions: {} });
check("empty questions are rejected", r.status === 400, r.payload);

r = await hit(mkEnv(), "POST", "/api/decide", {
  state: "x",
  questions: { q: { type: "noul", instructions: "?" } },
  model: "perplexity/pplx-decider-v1.3"
});
check("an explicit model overrides the pick",
  r.status === 200 && r.payload.model === "perplexity/pplx-decider-v1.3" && r.payload.pick.key === "custom",
  r.payload);

// --- audit record relay -------------------------------------------------------

let seenKey = null;
const truthStub = (status, body) => ({
  async fetch(url, init = {}) {
    seenKey = init.headers && init.headers["x-admin-key"];
    globalThis.__auditCall = { url: String(url), init };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
});

r = await hit(mkEnv(), "POST", "/v1/audit/store", { id: "a1", content: "Motion" });
check("store fails closed without a truth key",
  r.status === 503 && r.payload.error === "truth_key_not_configured", r.payload);

r = await hit(mkEnv({ TRUTH_ADMIN_KEY: "k3y", TRUTH: truthStub(200, { success: true, id: "a1", saved_at: "2026-11-14T00:00:00.000Z" }) }),
  "POST", "/v1/audit/store", { id: "a1", content: "Motion" });
check("store relays to truth and hands back the id",
  r.status === 200 && r.payload.id === "a1" && r.payload.stored === true, r.payload);
check("it writes to truth's audit route", String(globalThis.__auditCall.url).endsWith("/api/truth/audit"));
check("the admin key travels on the relay", seenKey === "k3y");

r = await hit(mkEnv({ TRUTH_ADMIN_KEY: "k3y", TRUTH: truthStub(401, { error: "admin_key_required" }) }),
  "POST", "/v1/audit/store", { id: "a1", content: "Motion" });
check("a refused write is never reported as saved",
  r.status === 502 && r.payload.error === "audit_not_stored", r.payload);

r = await hit(mkEnv({ TRUTH: truthStub(200, { success: true, audit: { id: "a1", content: "Motion" } }) }), "GET", "/v1/audit/a1");
check("a record link resolves through the relay",
  r.status === 200 && r.payload.audit.content === "Motion", r.payload);

r = await hit(mkEnv({ TRUTH: truthStub(404, { error: "audit_not_found" }) }), "GET", "/v1/audit/missing");
check("a missing record stays a 404", r.status === 404 && r.payload.error === "audit_not_found", r.payload);

// --- summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
