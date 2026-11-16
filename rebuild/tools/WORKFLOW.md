# Search tool + the workflow around it

Note written 2026-11-14. Nothing here is applied to the truth preset or to any Worker.

## What exists now

| File | What it is |
| - | - |
| `searx-tool.mjs` | `SEARX_TOOL` — the function-tool definition in OpenRouter's shape; `runSearxCall` — the executor our side runs; `runSearchLoop` — the whole round trip |
| `searx-tool.test.mjs` | 33 checks, all passing, no network |

The tool is a **user-defined function**, not a server tool: the model calls it, our code
executes it, and it goes in the top-level `tools` array. Its name is `searx_search` and it
takes `queries[]` (1–8), `count` (1–15), `time_range`, `language`, `categories`.

The executor leans on the instances TEW already uses — primary `SEARX_URL` (default
`https://searing-render.fly.dev`), fallback `SEARX_FALLBACK_URL`, the same hedge:
primary starts at once, fallback joins after `SEARX_HEDGE_MS`, first success wins.

Every result carries provenance: which instance answered each query, how long it took, how
many results came back, and the error text if one failed. That is the difference between a
search that happened and a search that was claimed.

## The workflow, in order

1. **Domain awareness, before anything is asked.** Name the domain and the principles that
   domain demands. TEW already has this: `POST /api/classify` returns `{domain, principles}`
   from Workers AI, and the NSM layer holds per-domain principles, patterns and confidence.
   This is what makes the next steps domain-specific rather than generic.
2. **Searches as real-world checks.** Several angles in one call — the statute, the
   procedure, the court's own published practice — rather than one query standing in for
   research. `queries[]` exists so this is a single round trip.
3. **The model reads the results back as tool output**, not as prose it invented. The
   envelope it receives is `{ok, searches:[{query, backend, results, ms, error}], results,
   errors}`.
4. **The ceilings decide what may be asserted.** With search done and contextualised against
   the domain principles, the response may go above the baseline; without it, it stays at the
   baseline and says why. The provenance above is what makes that checkable rather than a
   claim in a header line.
5. **Then the human.** Nothing reaches the eitl as an unmarked assertion — what was searched,
   what it established and what is still missing travel with it.
6. **Saving.** This is the open piece, and it is not a proxy concern. The audit route relays
   the preset's answer and stores nothing; saving belongs to `truth`, which already holds
   master / provisional / memory and is the source. What gets saved, and at which stage,
   is your decision, not something to invent here.

## What wiring it needs

- `runSearchLoop` has to run wherever the OpenRouter request is made. Today that is
  `ai-proxy`'s `/v1/audit` (a relay: caller messages in, preset answer out) and TEW's
  `LLMRouter`, which calls `@preset/truth` either through the `ORPROXY` binding or with
  `OPENROUTER_API_KEY`. Adding `tools:[SEARX_TOOL]` and the loop to that call is the change.
- Bindings: `SEARX_URL` and `SEARX_FALLBACK_URL` must exist on whichever Worker runs the
  loop. TEW has them; `ai-proxy` has no such vars today.
- A function tool cannot be used inside `openrouter:subagent` (nested client functions are
  rejected unless `inherit_functions`, Responses API only). At the top level it is fine.

## Related capabilities, verified in the docs today

- `openrouter:advisor` — consult a stronger model mid-generation; returns `{status, model,
  advice}`; `tool_choice:"required"` forces a consultation; consultations are capped per
  request and recursion is blocked.
- `openrouter:subagent` — delegate to a cheaper worker that sees only `task_description`.
- `openrouter:apply_patch` — V4A diffs, Responses API only, validated at OpenRouter and
  applied by the application; never applied server-side.
- `usage.server_tool_use_details` reports `tool_calls_requested`, `tool_calls_executed` and
  `web_search_requests` per request — the same kind of evidence for server tools that the
  provenance envelope above provides for ours.

## Measured facts about the preset

- `truth` is on version 34; its ceiling block is the eitl 7 line only.
- Version 34's config is `{"models":[...]}` — no tools. Versions 11, 12, 13 and 17 carried
  `openrouter:web_search`; v18 dropped it.
- Writing a preset version needs a read-write management key; the Worker's key is
  inference-only (`401 Invalid management key`).

## Undecided, for you

1. Which searches count as the real-world checks — per claim, per domain, or per document.
2. What is saved, at which stage, and by `truth` rather than by the proxy.
3. Whether the eitl is a human, an `advisor` consultation, or both, and which of those the
   ceiling reads as approval.
