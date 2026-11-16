// Checks for searx-tool.mjs. No network: fetch is stubbed.
import { SEARX_TOOL, runSearxCall, runSearchLoop } from "./searx-tool.mjs";

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (detail ? "  -> " + detail : ""));
  }
};

const searxPage = (n, tag) => ({
  ok: true,
  status: 200,
  json: async () => ({
    results: Array.from({ length: n }, (_, i) => ({
      title: `${tag} result ${i}`,
      url: `https://example.com/${tag}/${i}`,
      content: `snippet ${i} for ${tag}`,
      engine: "duckduckgo"
    }))
  })
});

// A fetch that routes by URL and records every call it saw.
function makeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) return handler(url, init, calls);
    }
    throw new Error("no route for " + url);
  };
  f.calls = calls;
  return f;
}

const env = { SEARX_URL: "https://fly.example", SEARX_FALLBACK_URL: "https://render.example", SEARX_HEDGE_MS: 10 };

console.log("tool definition");
ok("name is searx_search", SEARX_TOOL.function.name === "searx_search");
ok("requires queries", SEARX_TOOL.function.parameters.required.includes("queries"));
ok("8 query cap", SEARX_TOOL.function.parameters.properties.queries.maxItems === 8);

console.log("\nprimary answers");
{
  const f = makeFetch([["fly.example", () => searxPage(9, "fly")]]);
  const out = await runSearxCall({ queries: ["one"], count: 4 }, env, f);
  ok("ok", out.ok === true);
  ok("backend is the fly instance", out.searches[0].backend === "https://fly.example");
  ok("count respected", out.results.length === 4, String(out.results.length));
  ok("no errors", out.errors.length === 0);
  ok("render was not called", !f.calls.some((c) => c.url.includes("render.example")));
}

console.log("\nprimary is slow, the hedge wins on the fallback");
{
  const f = makeFetch([
    ["fly.example", () => new Promise((r) => setTimeout(() => r(searxPage(3, "fly")), 120))],
    ["render.example", () => searxPage(5, "render")]
  ]);
  const out = await runSearxCall({ queries: ["slow"] }, env, f);
  ok("ok", out.ok === true);
  ok("fallback answered", out.searches[0].backend === "https://render.example", out.searches[0].backend);
  ok("results came from the fallback", out.results[0].url.includes("/render/"));
  ok("both were tried", f.calls.some((c) => c.url.includes("fly.example")) && f.calls.some((c) => c.url.includes("render.example")));
}

console.log("\nboth instances fail");
{
  const f = makeFetch([
    ["fly.example", () => ({ ok: false, status: 502 })],
    ["render.example", () => ({ ok: false, status: 500 })]
  ]);
  const out = await runSearxCall({ queries: ["nothing"] }, env, f);
  ok("not ok", out.ok === false);
  ok("error names the fallback", out.errors.join(" ").includes("render.example"), out.errors.join(" "));
  ok("no results", out.results.length === 0);
}

console.log("\nseveral queries in one call");
{
  const f = makeFetch([["fly.example", (u) => searxPage(3, u.includes("alpha") ? "a" : "b")]]);
  const out = await runSearxCall({ queries: ["alpha", "beta"] }, env, f);
  ok("two searches recorded", out.searches.length === 2, String(out.searches.length));
  ok("results merged", out.results.length === 6, String(out.results.length));
  ok("no duplicate urls", new Set(out.results.map((r) => r.url)).size === out.results.length);
}

console.log("\nfilters reach the query string");
{
  const f = makeFetch([["fly.example", () => searxPage(2, "x")]]);
  await runSearxCall({ queries: ["q"], language: "en-US", categories: "news", time_range: "week" }, env, f);
  const url = f.calls[0].url;
  ok("language", url.includes("language=en-US"));
  ok("categories", url.includes("categories=news"));
  ok("time_range", url.includes("time_range=week"));
  ok("format=json", url.includes("format=json"));
}

console.log("\nempty call");
{
  const out = await runSearxCall({ queries: [] }, env, makeFetch([]));
  ok("rejected", out.ok === false && out.error === "no_query");
}

console.log("\nthe loop: model asks to search, then answers");
{
  let round = 0;
  const f = async (url, init) => {
    if (String(url).includes("openrouter")) {
      round++;
      const body = JSON.parse(init.body);
      if (round === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call_1", type: "function", function: { name: "searx_search", arguments: JSON.stringify({ queries: ["PC 484(a) elements"], count: 3 }) } },
                    { id: "call_2", type: "function", function: { name: "searx_search", arguments: JSON.stringify({ queries: ["San Bernardino warrant procedure"] }) } }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 }
          })
        };
      }
      const toolMessages = body.messages.filter((m) => m.role === "tool");
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "answer with " + toolMessages.length + " tool results" } }],
          usage: { prompt_tokens: 300, completion_tokens: 60 }
        })
      };
    }
    return searxPage(2, "web");
  };

  const out = await runSearchLoop({
    env,
    headers: { Authorization: "Bearer test" },
    body: { model: "@preset/truth", messages: [{ role: "user", content: "audit this" }], tools: [SEARX_TOOL] },
    fetchImpl: f
  });
  ok("loop ok", out.ok === true, out.error);
  ok("final content returned", out.content === "answer with 2 tool results", out.content);
  ok("two searches counted", out.searches === 2, String(out.searches));
  ok("two rounds recorded", out.rounds.length === 2, String(out.rounds.length));
  ok("assistant tool_calls replayed", out.messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls)));
  ok("tool messages carry ids", out.messages.filter((m) => m.role === "tool").every((m) => m.tool_call_id));
}

console.log("\nan unknown tool is reported, not dropped");
{
  const f = async (url) => {
    if (String(url).includes("openrouter")) {
      const first = !f.seen;
      f.seen = true;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: first
                ? { role: "assistant", content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "something_else", arguments: "{}" } }] }
                : { role: "assistant", content: "done" }
            }
          ]
        })
      };
    }
    return searxPage(1, "web");
  };
  const out = await runSearchLoop({ env, body: { messages: [] }, fetchImpl: f });
  const toolMsg = out.messages.find((m) => m.role === "tool");
  ok("reported as unknown_tool", toolMsg && toolMsg.content.includes("unknown_tool:something_else"), toolMsg && toolMsg.content);
  ok("loop still finishes", out.ok === true && out.content === "done");
}

console.log("\nrounds are capped");
{
  const f = async (url) => {
    if (String(url).includes("openrouter")) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "loop", type: "function", function: { name: "searx_search", arguments: JSON.stringify({ queries: ["again"] }) } }]
              }
            }
          ]
        })
      };
    }
    return searxPage(1, "web");
  };
  const out = await runSearchLoop({ env, body: { messages: [] }, fetchImpl: f, maxRounds: 2 });
  ok("stops with tool_rounds_exhausted", out.ok === false && out.error === "tool_rounds_exhausted", String(out.error));
  ok("it did not spin forever", out.rounds.length === 3, String(out.rounds.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
