# Snapshot — what's worth carrying into TEW

A record of the patterns observed in each app, taken 2026-11-14 by reading the
served assets. No code here: this is the shortlist, with the mechanic and why it
matters for a legal-first workstation.

TEW is the **Truth Engine Workstation**. Legal is its default lane; the others are
general. That ordering is the filter applied below.

---

## mind (`mind.ai-n.workers.dev`)

Static `index.html` + `style.css` + `script.js`. Cards, an LLM-backed chat, and the
preset toggle.

**1. The toggle ring, with Off first and always present.**
`cyclePreset()` builds `[none, ...serverPresetOrder, ...handAdded]` and steps one
place, wrapping. Off is a state, not a preset: it has no row and is never saved.
The bar reads `preset.name` or `Off`, and the button is only `.active` when a
preset is in force. Worth having because a two-state control that cycles beats a
dropdown for one-handed use, and "Off" is visible rather than a blank.

**2. Off changes the wire, not just the label.**
A pinned preset sends `preset: <slug>` and **no system prompt at all** — the preset
owns the prompt. Off sends `preset: "none"` plus the app's base prompt, because
nothing else is supplying one. Two genuinely different modes, not one call with a
flag.

**3. Off is the path into what is already known.**
With `preset: "none"` the Worker answered from its cache: `source: "cache"`,
`trace: ["cache:hit"]`, `cacheSource: "provisional"`, and the meta event named the
record — `truth.id: "say-ok"`, `key: "service:truth"`. A cached answer arrives as a
single delta. For a legal workstation this is the most valuable idea in the app: an
answer drawn from authority instead of generated, and legible as such.

**4. The first stream event is provenance.**
`{type:"meta", route, model, decision:{preset, task, depth, tone, source, trace,
cacheSource, truth:{layer, id, key}}, cacheKey}` then `{type:"delta"}` then `[DONE]`.
The client can show which authority answered without asking a second endpoint.

**5. The server publishes the list.**
`GET /api/presets` → `[{id,name}]` (`truth, doc, micro, mnl, operator`). The client's
table is only what an unreachable Worker leaves behind. Presets learned from the
server are marked `server:true`; ones it stops publishing leave the cycle; a
selected preset that vanishes drops back to Off rather than sending an id that
would fail. New preset on the server = appears in the UI with no client edit.

**6. `presetLocked` distinguishes intent.**
False until the preset menu has been used. The Worker can then tell a deliberate
pick (pin it) from the default (let the router decide) — same request shape, two
meanings.

**7. A proxy must prove it can serve presets.**
`verifyProxyUrl()` asks the configured URL for `/api/presets` and resets to the
default site if it can't answer, because a plain relay accepts the same POST,
ignores `preset`, and truncates instead of failing. Self-description as a
precondition for being trusted.

**8. Admin console (`/admin`).**
Unlock with `ADMIN_KEY` → `/api/admin/unlock` returns the store names; then a paged
key browser (`/api/admin/keys?store=&limit=200&cursor=`) with search, sort by
question/length/kind, export JSON, and single-record read. Editor with preview.
Save writes master truths. Keys live in `sessionStorage` only. Read + save only: no
delete, no demote. **Worth copying:** the shape, and the fact that it browses the
corpus rather than the raw namespaces alone. **Worth fixing:** the console sends a
caller-supplied `store` — allowlist it server-side.

---

## cods (`cods.ai-n.workers.dev`, "kards")

One 122 KB inline HTML file: no separate assets, no admin, no preset route.

**1. `/health` as a capability manifest.**
It reports what is actually wired: `clef_context`, `search_chain`
(`openrouter:web → browser → duckduckgo → github → wikipedia`), `text_models`,
`card_ops`, `mcp` tools, `memory:{context,archive,cache,kv,ltm,shapes,loader}`,
`themes`, `stream:"ndjson"`, and the booleans `approved`, `admin`, `truth_key`,
`openrouter`, `stt`. The UI can disable what isn't wired instead of failing on
click. Copy this endpoint shape into TEW.

**2. A domain taxonomy with `general` as one of eleven.**
`general, logic, math, code, medical, legal, finance, safety, news, research,
howto`. Correct for a general tool. TEW inverts the order — legal first, general as
the escape — but the vocabulary is useful.

**3. Approve → learn as an explicit human step.**
`approveCard`, `loadApprovedList`, `learnCardEdit` — a card is approved, then
learned, and edits are learned too. That is EITL in miniature and it maps onto
master/provisional promotion. Prefer it to automatic learning from any answer.

**4. A card operations vocabulary.**
`continue, magic, style, split, merge, template` — small verbs on an existing card
instead of new endpoints. `split`/`merge` on cards is the interesting pair: it makes
a long answer into units a reviewer can accept individually.

**5. Templates and principles as first-class lists.**
`loadTemplates`, `loadPrinciples`, `loadTruthList` — the workspace's own material is
browseable, not hidden behind an editor.

**6. Export/import of the whole board.**
`exportCards`, `exportMd`, `importCards`, plus `/share`. Portability is a trust
feature: a user can take the work out.

**7. Themes and STT/TTS built in.**
Six named themes, `micStart/micStop`, `browserSpeak`, `/stt`, `/speak`. Dictation is
the one accessibility feature every one of these apps has and TEW lacks.

**8. NDJSON streaming.** Different from mind's SSE; whichever TEW picks, the meta
event should come first.

---

## TEW (`tew.ai-n.workers.dev`)

The workstation itself. What is already good and should survive the rebuild:

- **Truth first on the query path.** `resolveTruth()` → `POST /api/truth/resolve`,
  returns `null` on any failure so a broken truth degrades rather than 500s, and a
  hit skips `deepQuery` entirely.
- **Provenance on the result.** Source type, id and layer travel with the answer.
- **Cards, principles, NSM panel** as the workspace model.
- **`/health` reports binding booleans** — the honest-capability idea, already here.

What it lacks that the others have: any auth, any cache-hit path, any preset
control, any corpus browser, dictation, themes, share links.

---

## Landing (`i.nspired.cc`)

Vite SPA: `/` marketing, `/engine`, `/a/:id` for a shared audit, catch-all.

**1. `/a/:id` — an artifact is a link.**
No login to read it. "Nothing is stored under that id." Every produced report should
be addressable; it makes review and disagreement possible between two people.

**2. The report contract.**
"Extracted claim and key assertions", "Contradictory information detected", "Open
questions and areas for further research", "Legal-risk decision: context for review",
"One thing would sharpen it:". Claims, contradictions, gaps, decision, next step.

**3. Citations on every answer.** "Every answer carries its citations, so it can be
tested before anyone acts on it."

**4. Contradiction surfaced, never smoothed.** "Each assertion is checked against the
others so disagreement is visible rather than smoothed over." This is the product's
central claim, and it is a *rendering* rule as much as a model rule.

**5. Human in the loop, stated plainly.** "Expert review stays in the loop", "Human
expertise remains accountable."

**6. Follow-up after the artifact, no purchase wall.** "Nothing to buy here. Ask a
follow-up below and keep going."

**7. Dictation on the input**, with real error copy for refused mic, missing device,
and no speech service.

**8. Invitation posture.** "A private, vetted network for people building real
systems, not hype." Access is a decision, not a signup form.

---

## Decision models (for the triage step, not the answer)

The model-choice table lives in `DECISIONS.md` under **Model choice** — one table,
one place. Deliberately not repeated here, so the two cannot drift apart.

---

## The shortlist

Ranked by what would most improve TEW, independent of effort.

1. Provenance-first stream event — says which authority answered, before the answer.
2. An Off state that resolves from truth/cache instead of generating.
3. `/health` as a capability manifest the UI reads.
4. Shareable artifact links (`/a/:id`).
5. Approve → learn as an explicit human step, in place of automatic learning.
6. A corpus browser (master/provisional) behind one admin key.
7. Citations and contradictions rendered, never smoothed.
8. Preset list published by the server, never hardcoded in the client.
9. Dictation on the input.
10. Export/import of the board.
