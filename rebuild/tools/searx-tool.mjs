// searx-tool.mjs — a user-defined function tool the model can call, backed by the
// SearXNG instances we already run (Fly primary, Render fallback).
//
// Two pieces:
//   SEARX_TOOL     the tool definition that goes in an OpenRouter request's `tools` array
//   runSearxCall   the executor: our side runs it, because user-defined tools execute in
//                  the application, not at OpenRouter
//
// Plus runSearchLoop: the whole round trip — model asks to search, we execute, we hand the
// results back, model answers. Provenance (which instance answered, how long, what failed)
// rides along in the tool result so the checks are auditable rather than claimed.

// Defaults mirror the ones TEW is running today: the Fly app is the primary, and the
// Render instance is only used when the primary is slow or down.
const SEARX_DEFAULT_PRIMARY = "https://searing-render.fly.dev";
const SEARX_DEFAULT_TIMEOUT_MS = 60000;
const SEARX_DEFAULT_HEDGE_MS = 4000;
const SEARX_DEFAULT_FALLBACK_TIMEOUT_MS = 15000;
const SEARX_MAX_RESULTS = 15;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const trim = (u) => String(u || "").replace(/\/+$/, "");

const primaryBase = (env) => trim(env && env.SEARX_URL) || SEARX_DEFAULT_PRIMARY;
const fallbackBase = (env) => trim(env && env.SEARX_FALLBACK_URL) || "";
const timeouts = (env) => ({
  primary: num(env && env.SEARX_TIMEOUT_MS, SEARX_DEFAULT_TIMEOUT_MS),
  hedge: num(env && env.SEARX_HEDGE_MS, SEARX_DEFAULT_HEDGE_MS),
  fallback: num(env && env.SEARX_FALLBACK_TIMEOUT_MS, SEARX_DEFAULT_FALLBACK_TIMEOUT_MS)
});

// The tool the model sees. It asks for queries, not for a "search" abstraction, so one
// call can carry the several angles a check needs.
export const SEARX_TOOL = {
  type: "function",
  function: {
    name: "searx_search",
    description:
      "Search our own SearXNG instances for sources on the open web. Returns titles, URLs and " +
      "snippets with the instance that answered, so results can be cited. Send one query per " +
      "distinct factual claim you need to check, up to eight at a time.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 8,
          description: "The searches to run. Each one is a separate query."
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: SEARX_MAX_RESULTS,
          default: 5,
          description: "Results wanted per query."
        },
        time_range: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Restrict results to this recency window when freshness matters."
        },
        language: { type: "string", description: "Language code, e.g. en, en-US." },
        categories: {
          type: "string",
          description: "SearXNG category: general, news, science, it, gov, file."
        }
      },
      required: ["queries"]
    }
  }
};

// One SearXNG request. Same endpoint shape TEW uses, with the optional filters added.
async function queryOnce(fetchImpl, base, query, opts, timeoutMs) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    safesearch: "0"
  });
  if (opts.language) params.set("language", opts.language);
  if (opts.categories) params.set("categories", opts.categories);
  if (opts.time_range) params.set("time_range", opts.time_range);

  const res = await fetchImpl(`${base}/search?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "tew-worker/1.0 (+SearXNG client)"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`returned ${res.status}`);

  const data = await res.json().catch(() => null);
  const rows = Array.isArray(data && data.results) ? data.results : [];
  const limit = Math.min(num(opts.count, 5), SEARX_MAX_RESULTS);
  return rows.slice(0, limit).map((r) => ({
    title: r.title || r.url || "Untitled",
    url: r.url || "",
    snippet: String(r.content || "").slice(0, 300),
    engine: r.engine || (Array.isArray(r.engines) ? r.engines.join(",") : null) || null
  }));
}

const describe = (base, err, timeoutMs) =>
  err && err.name === "TimeoutError"
    ? `${base} timed out after ${Math.round(timeoutMs / 1000)}s`
    : `${base} ${(err && err.message) || "failed"}`;

// One query against the pair: primary immediately, fallback after the hedge window.
async function searchOne(fetchImpl, env, query, opts) {
  const t = timeouts(env);
  const started = Date.now();
  const primary = primaryBase(env);
  const fallback = fallbackBase(env);

  const attempt = (base, ms) =>
    queryOnce(fetchImpl, base, query, opts, ms).then(
      (results) => ({ ok: true, results, backend: base, ms: Date.now() - started }),
      (error) => ({ ok: false, error, backend: base, timeoutMs: ms, ms: Date.now() - started })
    );

  const primaryRun = attempt(primary, t.primary);
  if (!fallback) {
    const only = await primaryRun;
    return only.ok
      ? { query, backend: only.backend, results: only.results, ms: only.ms }
      : { query, error: describe(primary, only.error, only.timeoutMs), results: [], ms: only.ms };
  }

  const raced = await Promise.race([
    primaryRun,
    new Promise((resolve) => setTimeout(() => resolve({ hedged: true }), t.hedge))
  ]);
  if (raced.ok) {
    return { query, backend: raced.backend, results: raced.results, ms: raced.ms };
  }

  // Hedge: start the fallback, and keep the primary in the race if it is still running.
  const runs = [attempt(fallback, t.fallback)];
  if (raced.hedged) runs.push(primaryRun);

  const winner = await new Promise((resolve) => {
    let pending = runs.length;
    const failures = [];
    for (const run of runs) {
      run.then((outcome) => {
        if (outcome.ok) return resolve(outcome);
        failures.push(outcome);
        if (--pending === 0) resolve({ ok: false, failures });
      });
    }
  });

  if (winner.ok) return { query, backend: winner.backend, results: winner.results, ms: winner.ms };
  const failures = winner.failures || (raced.hedged ? [] : [raced]);
  return {
    query,
    error: failures.map((f) => describe(f.backend, f.error, f.timeoutMs)).join("; "),
    results: [],
    ms: Date.now() - started
  };
}

// The executor. Arguments come from the model; the result is what the model reads back.
export async function runSearxCall(args, env, fetchImpl = fetch) {
  const queries = []
    .concat(Array.isArray(args && args.queries) ? args.queries : [args && args.query])
    .map((q) => String(q || "").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!queries.length) {
    return { ok: false, error: "no_query", searches: [], results: [] };
  }

  const opts = {
    count: args && args.count,
    time_range: args && args.time_range,
    language: args && args.language,
    categories: args && args.categories
  };

  const runs = await Promise.all(queries.map((q) => searchOne(fetchImpl, env, q, opts)));

  // Dedupe across queries so the same page is not handed back twice.
  const seen = new Set();
  const results = [];
  for (const run of runs) {
    for (const r of run.results) {
      if (r.url && seen.has(r.url)) continue;
      if (r.url) seen.add(r.url);
      results.push(r);
    }
  }

  const searches = runs.map((run) => ({
    query: run.query,
    backend: run.backend || null,
    results: run.results.length,
    ms: run.ms,
    error: run.error || null
  }));

  return {
    ok: runs.some((run) => run.results.length > 0),
    searches,
    results,
    errors: searches.filter((s) => s.error).map((s) => `${s.query}: ${s.error}`)
  };
}

// The complete round trip: request → tool calls → executed searches → final answer.
// Anything that is not searx_search is reported, never silently dropped.
export async function runSearchLoop({
  env,
  url = "https://openrouter.ai/api/v1/chat/completions",
  headers = {},
  body,
  fetchImpl = fetch,
  maxRounds = 3
}) {
  const messages = Array.isArray(body && body.messages) ? body.messages.slice() : [];
  const rounds = [];
  let searches = 0;

  for (let round = 0; round <= maxRounds; round++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify(Object.assign({}, body, { messages, stream: false }))
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: String(detail).slice(0, 300), messages, rounds, searches };
    }
    const data = await res.json();
    const choice = (data && data.choices && data.choices[0]) || {};
    const message = choice.message || {};

    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      rounds.push({ round, tool_calls: 0 });
      return {
        ok: true,
        content: message.content == null ? "" : message.content,
        messages: messages.concat([message]),
        rounds,
        searches,
        usage: data.usage || null
      };
    }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    const handled = [];
    for (const call of message.tool_calls) {
      const name = call.function && call.function.name;
      let args = {};
      try {
        args = JSON.parse((call.function && call.function.arguments) || "{}");
      } catch {
        args = {};
      }
      let payload;
      if (name === SEARX_TOOL.function.name) {
        payload = await runSearxCall(args, env, fetchImpl);
        searches += (payload.searches || []).length;
      } else {
        payload = { ok: false, error: `unknown_tool:${name}` };
      }
      handled.push({ name, args, payload });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(payload)
      });
    }
    rounds.push({ round, tool_calls: message.tool_calls.length, handled });
  }

  return { ok: false, error: "tool_rounds_exhausted", messages, rounds, searches };
}
