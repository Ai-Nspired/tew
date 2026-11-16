# Scoring — draft suggestions

Not applied. `tep.txt` stands as the copy of the prompt you gave me, plus your two ceiling
lines. Nothing here goes into the preset until you say so.

Context measured on 2026-11-14:

- Live preset `truth` is **version 34**; its ceiling block is one line — the eitl 7 line.
  The 3 and 5 lines exist in your copy, not in the preset.
- Version 34's config is `{"models": ["inclusionai/ling-3.0-flash", "openai/gpt-oss-20b",
  "nex-agi/nex-n2.5-mini"]}` — **no tools**. Versions 11, 12, 13, 17 and 18 carried a
  `tools` config, and `web_search` appears in them.
- The audit that scored 6 carried `E: 5 | M: 7 | C: 5` with no search performed.

---

## 1. Make the ceiling bind the parts, not just the total

Your line caps the score. It does not say the parts are capped, so `M: 7` passed on its own
while the total sat at 6.

Draft, one line after your three:

> The ceiling binds E, M and C as well as the score.

Fixes: a 7 in any column without eitl.

## 2. Put the caps in working order

Your three lines are unordered notes. The work happens in an order, and the order is what
stops the 5 being claimed off the principles without the search.

Draft: renumber them in the order they are earned — domain, then web-search, then the
domain-principle contextualisation, then eitl — keeping your wording on each line.

## 3. Require the rung to be named in the output

A cap nothing has to prove is a suggestion. The one place a claim can be checked is the
line already printed at the top.

Draft, appended to your Grounding Basis line:

> Name the rung: the domain and its principles, the search performed and what it
> established, or the eitl exchange. Unnamed means the ceiling is 3.

## 4. Say what counts as the web search

This is the loophole. Search results handed to the engine inside the input already look like
a completed search, and no line currently distinguishes them.

Draft:

> Web-based search means a search performed during this response, stating what was searched
> and what it established. Material supplied in the input is the input, not the search.

## 5. Decide the ceiling above 7

Nothing currently defines it. Eitl approval either lifts the ceiling or it does not.

Options: (a) eitl approval lifts the ceiling to 10 and no further line is needed;
(b) approval lifts it per finding, in writing, inside the response. Pick one.

---

## Separate decision — reachability

With no `tools` in v34's config, the engine cannot search, so with the caps binding, every
response caps at 3. Either the web-search tool comes back on the preset (as in v18) or the
3 ceiling becomes the practical ceiling for every audit you run.

Your call in both directions. Nothing here has been written into the preset.
