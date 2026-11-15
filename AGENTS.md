# AGENTS.md — TEW

**TEW is the Truth Engine Workstation**: the Worker at `https://tew.ai-n.workers.dev`
that hosts the collaborative card workspace, the principle engine, the NSM panel
and the query/audit paths. It is the centre of this account. Everything below is
written from TEW's point of view.

Live facts in this file were verified against the deployed Workers on **2026-11-14**.
Anything not verified says so. Do not upgrade an assumption to a fact without
re-checking it. §11 and §12 were added **2026-11-15** from the owner's own statements;
where they disagree with anything above, they win.

---

## 1. Security comes first

TEW currently has **no authentication on any route** and **`Access-Control-Allow-Origin: *`
on every response**. That is the starting condition, not a recommendation. Treat
every `/api/*` route as world-writable until §3 says otherwise.

When you touch this repo:

- **Do not widen the surface.** A new route is a security decision, not just a
  feature. Record in the commit message whether it is public, and why.
- **Never** put a secret, token, key or password in this repo, in `wrangler.jsonc`,
  in `index.html`, in a commit message, or in chat.
- **Do not** add service bindings, KV namespaces, R2 buckets or DO classes "for
  later". Every binding is reachable by whoever can reach the code.
- Ask before any change that makes a mutating route reachable by someone who could
  not reach it before.

---

## 2. How TEW is wired (verified)

Bindings in `wrangler.jsonc` — this file is the source of truth for the config,
not `project.md`, which is stale.

| Binding | Type | Value | Notes |
|---|---|---|---|
| `WORKSPACE` | Durable Object → `Workspace` | namespace `2afaa841cf3b4b77bdd950ed24b98fbd` | **`legacy-kv`** storage |
| `KV_NAMESPACES` | KV | `c09c7cc291e04061831f8d3d3ba4625a` | |
| `ORP_KV` | KV | `145a30ed3f974dab983eb37d2a5a5a8f` | |
| `AUDITS_KV` | KV | `8c19918f71fd420d8115e022d3014b9f` | |
| `CONTEXT_KV` | KV | `b78a25e9928e44b3ab0a3e9647a2ee33` | |
| `AI` | Workers AI | — | import/PDF/image extraction |
| `R2` | R2 | `truth-engine-assets` | |
| `ORPROXY` | service | `orproxy` | generation + audit relay |
| `TRUTH` | service | `truth` | **primary source of truth** on `/api/query` |

Vars: `SEARX_URL` (Fly, primary), `SEARX_FALLBACK_URL` (Render, after an 8s hedge),
`SEARX_TIMEOUT_MS=20000`, `SEARX_FALLBACK_TIMEOUT_MS=60000`, `SEARX_HEDGE_MS=8000`.

Two config rules that cost deploys to learn:

- **`exports`, not `migrations`.** The DO lives under `"exports": {"Workspace":
  {"type": "durable-object", "storage": "legacy-kv"}}`. The two mechanisms are
  mutually exclusive; a provisioned class missing from `exports` fails with
  `provisioned_class_missing_from_config`.
- **Storage type is `legacy-kv`, permanently.** Declaring `sqlite` fails with
  `storage_type_mismatch`. Storage cannot be changed after namespace creation.
- `wrangler.jsonc` must stay **plain JSON**. A `//` comment broke parsing once.

Deploy is **push to `main` → Cloudflare Workers Builds** (`npx wrangler deploy`,
no build command, root `/`). There are no GitHub Actions and no webhooks involved.

---

## 3. The exposure surface (verified 2026-11-14)

Ranked by what an anonymous caller can actually do.

| Route | Method | Auth | Impact |
|---|---|---|---|
| `/api/fetch` | POST | none | **SSRF.** Fetches any caller-supplied URL server-side, stores the raw HTML as a card. No allowlist, no egress restriction. |
| `/api/proxy` | GET | none | **Open relay + SSRF.** Browser-UA fetch of any `?url=`, returned to the caller — a public CORS proxy running on your Worker. |
| `/api/kv/all` | GET | none | **Data dump.** Lists and reads up to 100 keys from each of all four KV namespaces, values included. |
| `/api/principles/kill` | POST | none | **Governance mutation.** Deletes any principle whose `ratificationStatus` is not `auto` (`auto` is immortal, everything else is deletable). |
| `/api/ws` | GET | none | **Live workspace access.** Unauthenticated WebSocket into the `Workspace` DO; receives broadcasts. |
| `/api/cards`, `/api/cards/dock`, `/api/cards/manipulate`, `/api/sync`, `/api/domains/sync` | mixed | none | Read/write the entire workspace state. |
| `/api/eitl/review`, `/api/principles`, `/api/domains`, `/api/domains/stack` | mixed | none | Mutate the EITL and principle systems. |
| `/api/query` | POST | none | Writes a Query card, calls truth, may trigger generation. |
| `/api/import` | POST | none | Base64 → Workers AI. Burns AI quota and storage. |
| `/api/search`, `/api/nsm/*`, `/api/classify`, `/api/compliance`, `/api/instruct` | POST | none | Burns subrequest/quota; `/api/search` reaches your SearXNG instances. |

`/api/health` and `/health` are safe to expose (they report booleans only).

There is **no rate limiting anywhere in TEW**, and no request size or method guard
beyond what individual handlers do.

---

## 4. The trust boundary around TEW

TEW sits in front of three other Workers. Their posture is not better than TEW's,
so a route added here can spend money elsewhere:

```
browser ──► TEW ──ORPROXY──► orproxy ──PROXY──► ai-proxy ──► openrouter.ai (key)
                                                        └──► Workers AI
        └──TRUTH───► truth ──OP──► pi-harness-example (@preset/truth)
                          └──JUSTICE──► justice
```

- **`orproxy`** is a 504-byte forwarder: `PROXY → ai-proxy`, every path and query
  passed through, no auth, no rate limit. It is a public alias for `ai-proxy`.
- **`ai-proxy`** has `OPENROUTER_API_KEY`, and `/api/chat`, `/api/generate`,
  `/api/embed` are unauthenticated. Its `RATE_LIMITER` binding is declared but
  **never referenced** — nothing is throttled. 13 of its 22 bindings are never
  referenced at all (`AURA`, `AURA_FILES`, `AVS`, `AVS_DO`, `JUSTICE`,
  `MATRIXSBOX`, `MATRIX_SERVICE`, `OG`, `SESSION_DO`, `SESSION_SERVICE`, `TEP`,
  `CHAT_DB`, `RATE_LIMITER`). Its admin paths **fail closed** (`503
  admin_not_configured` while `ADMIN_SECRET` is unset) — keep it that way.
- **`truth`** gates its six write paths on `ADMIN_KEY` via `x-admin-key` (401
  without it, verified). Its **reads are open**, including
  `/api/truth/provisional/query`, which returns stored answers, and
  `/debug/kv-status`, which discloses master/provisional/memory counts and binding
  state.
- **Generation** for truth runs through `pi-harness-example` (`OP` binding,
  `@preset/truth`). `ai-proxy`'s `/candidate` returns
  `503 {"error":"generation_suspended","reason":"containment"}` for every payload;
  truth's fallback to it is dead, and only the `OP` path works.

Rule of thumb: **adding a TEW route that reaches generation reaches your OpenRouter
balance.** Guard it before it ships.

---

## 5. Truth is the source; TEW is the client

**Legal first.** TEW is the Truth Engine Workstation, not a general chat surface.
Legal is the default lane and truth is the default answer: `resolveTruth()` runs
before generation on every path that asks a question, and a miss is the only reason
to generate. The general domains exist as an escape lane for material that plainly
is not legal — never as the default. The sibling apps (`mind`, `cods`) are general
first with legal as one of eleven domains; do not copy that ordering here.

`POST /api/query` calls `TRUTH` → `POST /api/truth/resolve {"input": ...}` **first**.
A hit is returned as a `truth` result and the LLM path is skipped entirely;
generation runs only when truth cannot answer (no binding, non-2xx, malformed
body, empty answer, or 20s timeout → `null` → the existing `deepQuery` path).

Do not move generation back in front of truth. Do not let a new feature bypass
`resolveTruth()` if it is answering a question the truth store may hold. The truth
store currently holds 31 master truths, 10 provisional, 1150 memory entries.

Truth's read routes are open, so anything TEW writes into truth must be treated as
publishable: never write secrets, credentials or private user content as a
provisional answer.

---

## 6. Working rules for this repo

1. **Verify against the deployment, not the repo.** `project.md` and `metadata.json`
   have both been wrong about which Worker this is and how it deploys.
2. **`worker.js` is the only served source.** `index.html` is a mirrored client
   copy; it is not served. Keep them in sync when touching client code.
3. **Check the deployed behaviour after a push**: `GET /health`, then the specific
   route you changed. A green build is not a working route.
4. **The DO is `legacy-kv`.** Do not migrate storage, do not "fix" it to sqlite.
5. **Fail safe on every dependency.** A missing or failing binding must degrade to
   the previous behaviour, not to a 500 — `resolveTruth()` returning `null` is the
   pattern to copy.
6. **No dependency additions** without a reason that survives review. The Worker
   currently ships with none.
7. When you learn something about the account's wiring that is not obvious from
   the code, add it to this file.

---

## 7. Open security work (TEW first)

Priority order; none of these are done.

1. **Close the SSRF pair.** `/api/fetch` and `/api/proxy` take arbitrary URLs.
   Needs an allowlist, a scheme check (http/https only), and a response size cap.
2. **Gate `/api/kv/all`.** It dumps every namespace. Owner-only or delete it.
3. **Decide the auth story for `/api/*`.** Every mutating route is open today.
   Minimum: an `x-admin-key` gate mirroring truth's `ADMIN_KEY` pattern for
   `/api/principles/*`, `/api/kv/all`, `/api/sync`, `/api/domains/sync`.
4. **Authenticate `/api/ws`.** An unauthenticated socket receives broadcasts and
   can mutate workspace state.
5. **Rate limit.** TEW has none; `ai-proxy` has an unused `RATE_LIMITER` binding.
   Both are spend paths.
6. **Narrow CORS.** `Access-Control-Allow-Origin: *` on a workspace with a DO
   behind it.
7. **Lock `truth`'s `/debug/kv-status`** and decide whether
   `/api/truth/provisional/query` should stay public.
8. **Remove `ai-proxy`'s 13 dead bindings** once the rebuild is planned — unused
   service bindings are reachable surface.

---

## 8. Stop means stop

When the owner says shut up, stop talking, or anything that ends the turn: stop in that same
breath. No summary, no restatement, no apology paragraph, no follow-up question, no "understood"
plus three sentences. One line at most, or nothing until asked.

Talking after a stop order is itself the violation, and repeating it is how trust gets lost here.
The same applies to repeats: the second time he says it, the reply is silence, not an explanation
of why the first one was reasonable.

## 9. "You're missing something" means ask, not guess

When the owner says something is missing or wrong, do not hunt for a candidate and present it as
the answer. Ask what it is, in one line, and wait. Two guesses in a row is already too many.

## 10. Check in before changing a file

No file is edited until the owner has seen which file, what changes, and why, and said to go
ahead. One check-in per change; a "yes" covers that change only. Reading is always fine.

When the owner says **update** a document, that is the go-ahead for that document: write in what
he just told you, and **delete any language anywhere in it that contradicts what he said**. An
update that leaves a stale claim standing is not an update.

---

## 11. Access — use what you have before asking for it

The owner has given standing access to GitHub and Cloudflare. Asking for it is a mistake. Writing
a credential into a file, a command, a commit message or chat is a worse one.

**GitHub.** `Ai-Nspired/tew` is connected for this account; it pushes through the authenticated
integration. Every other repo is reachable with `GITHUB_PAT` from the environment, through an
askpass helper, so the token never appears in a URL or a command line:

- identity inside each repo: `dno-luigi <dno@ai-n.org>`
- push: `GIT_ASKPASS=/tmp/askpass.sh git push origin HEAD:main`, where the helper prints
  `x-access-token` then `$GITHUB_PAT` (recreate it — `/tmp` does not survive)
- a push to `main` is what deploys TEW (Workers Builds, `npx wrangler deploy`)

**Cloudflare.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ID` are in the environment, so `wrangler`
works with no login: `deploy`, `deployments`, `tail`, KV / D1 / R2 operations, `--dry-run`. Never
run `wrangler login`. Never print or write the token. **A Worker whose source you cannot see gets
pulled, not declared missing** — that is how ARA was inspected.

**Repositories seen 2026-11-15** (both connected accounts see the same set): `Ai-Nspired/tew`,
`dno-luigi/{cods, mind, truth, ai-proxy, orproxy, open-template, memKV, i.nspired, vibe, aiprox}`,
`Ai-Nspired/{pi-harness-example, truth-engine, cosmo, kdg, mmap}`. **There is no `ara` repo in
either account**, so ARA's source is not in GitHub as of that date.

---

## 12. ARA and the memory — the owner's statements, 2026-11-15

These are his decisions, not inferences. They override anything elsewhere that disagrees.

- **Memoria is ours, and she curates it.** `KV` `4a9bfbff…` holds the account's legacy memory
  (~1,150 entries) and is shared with mind's `MEM` and truth's `PROV_TRUTH`. ARA reads it and
  **helps curate it**. It is not off limits, and it is not a cache to be ignored.
- **Cache expires; records do not.** Anything a person will later ingest, promote or correct gets
  no TTL, or a day at minimum — **never `expirationTtl: 3600`**. Candidates written with an hour
  on them could never be promoted, because promotion is a later read of something already gone.
  That is the actual fault behind candidates failing to reach master truth.
- **Paid deciders only. Never a `:free` slug** — the price of free is that they get to look at our
  data. Ladder: `pplx-decider-flash-v1.2` ($0.01/M) → `pplx-decider-v1.2` ($0.02/M, several
  questions per pass) → `scaledown/classify-1` ($0.04/M, documents and 1M ctx). `ai-proxy`
  `POST /api/decide` already routes this ladder and returns `usage.cost`.
- **`AI_SEARCH` is not wanted.** It was removed deliberately. Do not add it back.
- **Microsites** are reached without any preset or proxy switch turned on.
- **ARA's own bindings**: `BROWSER`, `DB` (D1 `248766b1-d102-4e9e-a228-a19281ed5fe6`),
  `R2` (`speakeasy-files`), `KV` (`4a9bfbff…`), `OPENROUTER_API_KEY`.
- **A decision model writes nothing.** It answers presented questions; it never composes a
  question, never writes prose, never writes the table. Rows are written by the workflow from the
  interaction — what was asked, what was decided, whether that was correct.

