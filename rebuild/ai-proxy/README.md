# ai-proxy rebuild — pure gateway

`worker.js` here is a **paste-ready replacement** for the live `ai-proxy` script.
Nothing has been deployed. The live Worker keeps serving until you paste this into
the dashboard and save. `aiproxy.txt` at the repo root is the live source this was
built from, and stays untouched so it remains a rollback.

Built by removing code from the live file rather than rewriting it, so the parts
that work today are the parts that shipped. 55,263 → 32,211 bytes.

## Removed

| Removed | Why |
|---|---|
| `EG` — the evidentiary gate (~200 lines of assertion families keyed to Case No. MSB26006196) | Policy, not transport. It validated a report schema the gate itself defined. |
| `AUDIT_SYSTEM_PROMPT` — 4,664 characters, ~730 words, hardcoded | Written by someone else and never approved. A court-docket evidentiary reviewer with A–E labels and its own mandatory rules. It is not `tep.txt` (the prompt the preset uses, ~1,143 words): their long words overlap 57/211, and it emits no CONFIDENCE SCORE and no CRAC. Removed, and the harness asserts it cannot come back. |
| `/v1/audit`, `/v1/audit/store`, `/v1/audit/:id` | The audit surface that existed only to apply that prompt. |
| `storeAudit`, `auditMarkdown`, `pushAuditCard`, `handleAudit`, `handleAuditStore` | Now unreachable. |
| `PAYMENT_INFO`, `handlePipeline`, `/v1/pipeline` | Held live Chime and CashApp handles and returned payment instructions to any caller. |
| `pushProvisional` | Wrote answers into truth's provisional store; its only caller was the audit store. The gateway no longer writes to truth. |
| `AUDIT_MODEL`, `AUDIT_MAX_TOKENS`, `AUDIT_BACKUP_MODEL`, `CONFIG.AUDIT_TTL` | Unused once the audit handlers went. |
| Admin `/api/admin/audits` | Listed records nothing writes any more. |

The `AUDITS` KV binding is still declared on the script and still reported by
`/health`; removing the binding itself is a dashboard action, not a code change.

## Changed

| Change | Why |
|---|---|
| `secretOk()` returns **false** when `ADMIN_SECRET` is unset | It returned `true`. Admin only stayed closed because `handleAdmin` hits a 503 one line earlier. |
| `cfModel()` / `orModel()` namespace policy | `@preset/truth` was passed to `env.AI.run`, which produced `5007: No such model`. `@cf/*` now goes only to Workers AI; everything else only to OpenRouter. |
| New `POST /chat/completions` and `/v1/chat/completions` | OpenAI-compatible shape. This is the exact path `tew` calls through `orproxy`, and it did not exist — those calls 404'd. |
| `/health` reports `containment: {generation, learning}` | The switch that suspends `/candidate` lives in KV and was invisible. |
| Optional `RATE_LIMITER` on generation routes | Declared and referenced zero times before. Used when present, ignored when absent, fails open on error. |
| The `@preset/truth` default is gone | It named a preset in the gateway and silently answered every modelless call. `model` is now required on the OpenAI route and internal calls read `OPENROUTER_MODEL`, failing loudly when neither is set. No preset string survives in the file. |
| New `POST /api/decide` | The Decisions API component: picks flash, the 27B or classify-1 from the state size and question count, escalates rather than truncating, normalises refusals, and returns `usage.cost`. Question sets are the caller's. |

## Unchanged

`/candidate` still returns `503 generation_suspended` while `containment:generation`
exists in the `ORP` namespace (`145a30ed3f974dab983eb37d2a5a5a8f`). Auto-learning
still obeys `containment:learning`. No binding is added or renamed. One is removed
in cutover: `TEP`, a Secrets Store binding that neither script reads.

## Still in there, and still questionable

- `learnFromAnswer` writes the model's own answers into the `ORP` knowledge store
  (`source: "auto"`, confidence 0.78) and every chat call can trigger it. The
  `containment:learning` flag is its only brake.
- `/api/mcp` returns a `501` whose message is addressed to a person.
- `mind.ai-n.workers.dev/api/chat` is a third fallback leg that returns 404.
- Twelve declared bindings are unreferenced by this script. Eleven are connections
  to other Workers — `JUSTICE`→justice, `AURA`, `AURA_FILES`, `AVS`, `AVS_DO`,
  `MATRIXSBOX`, `MATRIX_SERVICE`, `OG`→truthengine, `SESSION_SERVICE`,
  `SESSION_DO`→SessionMemory — plus `RATE_LIMITER`, which this version does use.
  The twelfth is `TEP`, a `secrets_store_secret` binding. Neither this script nor
  the live one reads it, the secret has been deleted, and the binding goes in
  cutover. What it held is not recorded in anything I have read.

## Verify

```sh
node --check rebuild/ai-proxy/worker.js   # parses as one ES module
node rebuild/ai-proxy/test.mjs            # 30 checks, stubbed bindings, no network
```

The harness imports the file exactly as the dashboard runs it and stubs `AI`, every
KV, `TRUTH`, `TRUTH_BUCKET`, `fetch` and the rate limiter. It covers the removed
routes returning 404, the absent prompt and gate, the OpenAI route, the preset
model fix, `/candidate` with containment both on and off, admin failing closed, and
the limiter failing open.

## Cutover

1. Dashboard → Workers → `ai-proxy` → Edit code.
2. Paste `rebuild/ai-proxy/worker.js` in full, save and deploy.
3. `curl https://ai-proxy.ai-n.workers.dev/health` — expect `status: "healthy"` and
   `containment: {generation: …}`. `orproxy` inherits it; it forwards every path.
4. `curl -X POST https://orproxy.ai-n.workers.dev/chat/completions -H 'content-type: application/json' -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"say ok"}]}'`
   — expect `choices[0].message.content`.
5. Generation returns only when you delete `containment:generation` from the `ORP`
   namespace. Nothing in the Worker can do it; it is a KV key, so dashboard or
   `wrangler kv key delete` is the only route.
6. Remove the `TEP` binding: Workers → `ai-proxy` → Settings → Bindings. It points
   at a secret you have deleted and no code reads it. Leave the other eleven alone —
   they reach other Workers, and this script does not use them.

## Rollback

Paste `aiproxy.txt` back. It is the current live script, so rollback restores exactly
today's behaviour, including the audit surface.
