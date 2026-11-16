# Credential map — before rotating

Names only. Every value here was read from the deployment or the source, never printed.

## Who holds what

| Worker | Secret names on the worker | Read in code | What it authorises |
|---|---|---|---|
| `tew` | `ADMIN_KEY`, `LEARN_KEY`, `ARA_KEY` | `ADMIN_KEY` ×3, `LEARN_KEY` ×1, `ARA_KEY` ×1, `OPENROUTER_API_KEY` ×4 (see note) | sheet/admin panel; `x-learn-key` on `/api/learn`; `x-admin-key` outbound to ARA; OpenRouter direct call |
| `ara` | `ADMIN_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ID` | `ADMIN_KEY` ×1 (the gate), `OPENROUTER_API_KEY` in `loop.js` | gates `/feedback`, `/outcome`, `/recent`, `POST /domains`; pays for the decider. **The gated route is `/recent`; `/api/recent` is a heartbeat that answers 200 to anyone.** |
| `mind` | `ADMIN_KEY`, `ARA_KEY`, `CLOUDFLARE_API_TOKEN`, `OPENROUTER_API_KEY` | `ADMIN_KEY` in `server/index.js` (console gate, fails closed); `ARA_KEY \|\| ADMIN_KEY` in `src/ara.js`; `LEARN_KEY` in `src/learn.js` | console access; writes to ARA; reads the TEW ladder — **but `LEARN_KEY` is not set on mind, so the ladder read is currently inert** |
| `cods` | `OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` ×12 in its worker | model calls |
| `truth` | `ADMIN_KEY` | `ADMIN_KEY` ×4 | write/ops routes; TEW's `/api/truth/resolve` call sends no key |
| `ai-proxy` | `OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` | the proxy's upstream key |
| `orproxy` | `ADMIN_SECRET`, `OPENROUTER_API_KEY` | `ADMIN_SECRET` constant-time in `rebuild/ai-proxy/worker.js` | proxy gate — note the deployed `ai-proxy` worker has only `OPENROUTER_API_KEY`, so that source is most likely the `orproxy` deployment; confirm which file builds which before rotating |
| `pi-harness-example` | `CLOUDFLARE_API_TOKEN`, `OPENROUTER_API_KEY` | — | harness |

Note: TEW reads `env.OPENROUTER_API_KEY` four times but the **secret is not on the worker**. The code falls back, which is why the decider probe reports `via proxy` — every TEW measurement takes the ORPROXY hop.

## The two contracts that must move in pairs

These are the only values that must be *equal across two workers*. Rotate one side alone and the call 401s until the other side catches up (seconds is fine, but don't leave it over a deploy).

1. `tew:ARA_KEY` == `ara:ADMIN_KEY` — TEW's ladder/probe writes into ARA, and `mind:ARA_KEY` also dereferences to `ara:ADMIN_KEY`. Three places to set:
   `ara:ADMIN_KEY`, `tew:ARA_KEY`, `mind:ARA_KEY`.
2. `tew:LEARN_KEY` == `mind:LEARN_KEY` (later `cods:LEARN_KEY`) — the shared ladder's read key. mind currently has no `LEARN_KEY`, so this is a pairing to *create*, not rotate.

Everything else is per-worker and independent: you can rotate `truth:ADMIN_KEY` or `cods:OPENROUTER_API_KEY` in isolation with no cross-worker window.

## Order I'd rotate in

Weakest and most exposed first; the pairs done as one step.

1. `tew:ADMIN_KEY`, `tew:LEARN_KEY`, `ara:ADMIN_KEY`(+`tew:ARA_KEY`+`mind:ARA_KEY`), `mind:ADMIN_KEY`, `truth:ADMIN_KEY` — the 4–5 character shared-secret family. These are the ones that were never strong enough to be called keys.
2. `orproxy:ADMIN_SECRET`, `ara:CLOUDFLARE _API_KEY`.
3. `OPENROUTER_API_KEY` everywhere (`tew`, `ara`, `mind`, `cods`, `ai-proxy`, `orproxy`, `pi-harness-example`) — deliberately last, because a new key has to be funded and live before the old one stops working. Also: put one on `tew` in this pass, or the probe keeps measuring through ORPROXY.
4. `CLOUDFLARE_API_TOKEN` on `ara`, `mind`, `cods`, `pi-harness-example` — this is the account-wide blast radius, and it is also the token *you* deploy with, so update the console/GitHub copy in the same session or your next deploy fails.
5. ~~Delete, don't rotate, what has no reader.~~ **Done 2026-11-16.** `cods:ADMIN_KEY`, `cods:KEY`, `cods:CLOUDFLARE_API_TOKEN`, `mind:KEY`, `ara:CLOUDFLARE _API_KEY` (with its space), and `pi-harness-example:SEARING_URL2` are deleted — each confirmed unread in its *deployed* script, pulled from the Cloudflare API rather than trusted from the repo. After: cods `/health` and root `200` with its markup, mind root `200`, ara `/recent` `401` without the header and `200` with it, harness root `200`.

## Rotating without ever printing the value

Generate and pipe straight into the worker, so the value never lands in shell history, a log, or this chat:

```
python3 -c "import secrets;print(secrets.token_urlsafe(32))" | npx wrangler@4 secret put NAME --name WORKER
```

`secret put` takes the value on stdin, and the generator's newline is stripped by Wrangler. For a pair, run it twice and treat the two values as one rotation: set ARA's first, then immediately set TEW's and mind's from the *same* value — which means capturing it once in a variable, not re-generating.

## Verifying a rotation finished

- ARA gate: `curl -s -o /dev/null -w '%{http_code}' -H "x-admin-key: $ARA_ADMIN_KEY" https://ara.ai-n.workers.dev/api/recent` → `200`; no header → `401`.
- TEW ladder: same with `x-learn-key` against `https://tew.ai-n.workers.dev/api/learn` → `200`, `401` without.
- TEW → ARA: `POST /api/decide` `{"action":"traffic"}` with `x-admin-key` → rows come back, not `401`.
- TEW panel: "What it learned" shows the cods rows; if it silently empties, the pair is split.
