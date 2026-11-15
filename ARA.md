# ARA — Autonomous Resolution Architecture

Spec for the system that resolves, so products only present. Written 2026-11-15.
Facts about the deployment were read from its own code and probed live; everything
else here is a decision to be built, not a description of what runs.

---

## 1. What ARA is

One system resolves a request and says how sure it is, where the answer came from,
and whether it is allowed to close on its own. Products — cods, mind, TEW, the
forms, the templates, truth — stop deciding and stop resolving; they send a request
and render the resolution.

Two consequences that define the whole design:

- **Resolution is central, presentation is local.** A product cannot resolve "its
  own way" any more. If a product needs different behaviour, it says so in the
  envelope; it does not get its own decider.
- **Autonomy is a policy, not an attitude.** ARA closes what policy permits and
  holds the rest for a person. It never invents a master answer.

---

## 2. What is deployed today (verified 2026-11-15)

Worker `ara` at `https://ara.ai-n.workers.dev`, a 1,115-line bundle.

| Route | Behaviour |
|---|---|
| `GET /health` | `{"status":"ok","kv":true,"latencyMs":0}` |
| `POST /resolve` | body `{prompt}` → `{response, trail_summary, cached, resolved_by}` |
| anything else | **200 `ara-engine-active`** — the catch-all should be a 404 |

`resolve(query, env)` as it stands:

1. hash the prompt, look it up in KV (1 hour TTL) → `resolved_by: "cache"`.
2. `checkEthics(query)` → `BLOCKED: <reason>` when it trips.
3. up to `MAX_LOOPS` searches through `webSearch()`, with fixed query rewrites
   (`"… data analysis verification"`, `"… technical specifications constraints"`).
4. confidence is arithmetic, not a model: `0.2 + 0.15 × (loop + 1)`, `+0.1` when
   there are three unique findings, breaking at `CONFIDENCE_THRESHOLD`.
5. `synthesize()` writes the "Analytical Breakdown" — Empirical Grounding, Causal
   Mechanism, Systemic Constraints, Historical Precedent, Statistical Baseline —
   over whatever was found. **No model is called at any point.**

Bindings it already has: `KV` (`4a9bfbff…`, the same namespace as mind's `MEM` /
truth's `PROV_TRUTH`), `AI_SEARCH`, `BROWSER`, `R2` (`speakeasy-files`),
`OPENROUTER_API_KEY`, `CLOUDFLARE_ID`, a Cloudflare API key.

What it does not have: a decider, master truth (the `904e…` namespace is not bound),
any record of what it decided, product identity (a `product` field is ignored), a
canvas, or auth. Its confidence number is a function of how many loops ran.

---

## 3. The layers

```
product ──► L0 front (contract) ──► L1 decider ──► L2 memory ──► L3 policy
                                        │                        │
                                        └──────────► L4 record ◄─┘
                                                          │
                                                   L5 canvas
```

- **L0 front** — the only way in. One envelope, one response shape, versions.
- **L1 decider** — typed questions, answered by a model, never by arithmetic.
- **L2 memory** — master truth, provisional, generated, web findings; every answer
  carries where it came from.
- **L3 policy** — decides whether a resolution may be closed or must be held.
- **L4 record** — every resolution, its cost, and what happened to it afterwards.
- **L5 canvas** — a live view of L0–L4. It is the system's window, not a product.

---

## 4. L0 — the contract

`POST /resolve`

```json
{
  "request": "what is a stop loss",
  "product": "cods",
  "context": { "thread": "…", "attachments": [], "history": [] },
  "expectations": { "maxCost": 0.002, "mustCite": false, "shape": "answer" }
}
```

`200` response:

```json
{
  "id": "res_…",
  "status": "closed" | "held",
  "resolution": "…",
  "route": ["truth:master", "generated:openrouter"],
  "confidence": 0.91,
  "evidence": [{ "kind": "master", "id": "t_…", "source": "…" }],
  "cost": { "usd": 0.0000412, "decisions": 1, "generation": 0 },
  "cached": false,
  "steps": [{ "layer": "decider", "ask": "can_truth_answer", "answer": false, "p": 0.12 }]
}
```

Rules:

- `prompt` stays accepted as an alias of `request`, and `response` stays as an alias
  of `resolution`, so today's callers keep working through the migration.
- `?stream=1` keeps the existing streamed form and adds one JSON line per step.
- `held` always says why in `evidence`, and never carries a resolution that looks
  finished.
- Every response carries `id`, so a product can ask about it later.
- Unknown paths are `404`. The catch-all `ara-engine-active` goes.

---

## 5. L1 — the decider

Typed questions over the state, in the shapes the Decisions API accepts
(`noul`, `choice`, `score`):

| question | type | what it decides |
|---|---|---|
| `intent` | choice | answer, transform, generate, compare, extract, route |
| `domain` | choice | legal first, then the escape lanes |
| `truth_can_answer` | noul | try memory before spending on generation |
| `needs_web` | noul | evidence is missing and the web would supply it |
| `needs_authority` | noul | the answer needs a source or ruling it does not have |
| `risk` | score | how much this resolution could cost if wrong |

The ladder, per DECISIONS.md and the Decisions API's own capability table:

1. `perplexity/pplx-decider-flash-v1.3:free` — text and image, 262K, $0.
2. `perplexity/pplx-decider-flash-v1.2` — $0.01/1M, **only for a single-question ask**
   (it bills the state per question).
3. `scaledown/classify-1` — $0.04/1M, 1M, documents and images, one document per
   request.
4. `cloudflare/clef-flash` → `clef-omni` → `clef` — the floor, through Workers AI, no
   key needed.

A `refusal`, a missing key, or an unexpected answer type means **not answered** and
moves down the ladder. It is never read as a negative. `usage.cost` is recorded for
every rung.

---

## 6. L2 — memory and provenance

Resolution order, first hit wins:

1. **master truth** — closed, citable, no TTL.
2. **provisional** — closes only when `confidence ≥ policy.minProvisional` and the
   product did not ask for a master.
3. **generated** — a model answer, always written back as a candidate.
4. **held** — nothing above cleared policy.

Every store write is a *candidate*. Promotion to master is a person's act, through
the truth worker's existing gate. ARA never promotes.

Cache key: hash of `request + normalized questions + product + context digest`.
Cache stores the whole response envelope, so a cache hit replays the evidence too.

---

## 7. L3 — the policy

A resolution is **closed** when any of these holds:

- a master truth answers it, or
- a provisional answers it with confidence ≥ `minProvisional` (0.8 default), or
- generated, with at least one citation, and `risk` under `maxRisk` (0.4 default), and
  the product asked for an answer rather than an authority.

Otherwise it is **held**, with the reason: no source, low confidence, high risk, an
authority it cannot reach, or the decider itself refused.

`held` is a normal outcome, not a failure. A product renders it as an open item.

---

## 8. L4 — the record, and what "learning" means

Every resolution writes one row: id, product, request hash, the decider's answers
with probabilities, the route, cost, status, and time. Afterwards a product may send
an **outcome**: `accepted`, `edited`, `contradicted`, `promoted`, `flagged`.

Learning is mechanical, not mystical:

- outcomes move a per-`domain`×`intent` confidence that feeds `minProvisional`;
- outcomes pick the cheapest rung that historically clears the bar for a domain;
- one row per resolution, so the canvas can show spend and closure rate;
- **nothing is trained.** No weights change. If a number moves, a stored outcome
  moved it.

---

## 9. L5 — the canvas

`GET /canvas` — a page ARA serves itself, not a card in a workstation.

- live list of resolutions as they happen: product, request preview, decider answers,
  which layer closed it, cost, held/closed;
- a held queue, each item with its reason and the act that would close it;
- a ledger: resolutions, closure rate, cache hit rate, spend by product and by rung;
- a decider panel: what it was asked, what it answered, with probabilities.

Transport: server-sent events from `GET /resolve?stream=1` for one resolution, and a
Durable Object feed for the canvas. If a DO is not worth it yet, poll `GET /record`
every few seconds; the canvas must not be the reason the front is slow.

---

## 10. Security and cost

- ARA becomes the account's front, so it is the place to gate: a per-product key
  (`x-ara-key`), a daily budget per product, and a hard stop when a budget is spent.
- Fail closed: no key, no budget, or a decider refusal means `held`, never a guess.
- No secret in this repo or in a response. Keys live in the Worker's settings.
- `/health` keeps reporting booleans only.
- Unknown paths `404`.

---

## 11. Rollout

1. **cods** — `POST /resolve` first; cods keeps its cards, loses its ladder.
2. **mind** — same front; its four intent questions move into the envelope.
3. **templates and forms** — resolution becomes a server call instead of browser logic.
4. **truth** — stays the memory and the promotion gate; ARA calls it, and never
   writes master.
5. **TEW** — a workstation client like the rest: it presents resolutions and holds.

Each step ships behind a switch, and a product that has not moved keeps working.

---

## 12. Open decisions

- **Record storage**: Durable Object (kv-backed, one per deployment) versus KV only.
  A DO gives the canvas a real feed and a total order; KV gives it cheap rows.
- **Master truth access**: bind `904e…` directly, or call the truth worker. Binding is
  faster and couples ARA to that namespace; calling keeps the gate in one place.
- **Budgets**: default daily spend per product, and who may raise it.
- **First call**: does `resolve` keep search-first behaviour, or does truth-first
  replace it? This spec says truth-first, web only when `needs_web` is answered yes.
