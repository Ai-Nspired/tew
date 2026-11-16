# ARA learning map

Written 2026-11-16. **Wired** means the code exists and runs today. **Proposed** means it is
a design for a decision you have not made yet — nothing in this document has been added to
cods, TEW, truth or ARA.

---

## 1. The shape, as it now exists in mind

Every decision follows the same four beats. Mind is the working example because all four are
already in the code:

| Beat | Mechanism | Where |
|---|---|---|
| Decide | `askAra(env, text, domain, choice, stored)` | `src/ara.js:12`, called at `src/index.js:643` |
| Act | route to truth, generate, or make a palette | `src/index.js:685` (`styling`), `openUpstream` |
| Record what came back | `reportOutcome(env, id, {returned, stored, route, origin})` | `src/index.js:706`, and again after a palette at the stream's end |
| Record his correction | `sendVerdict(env, {id, correct, correctedTo})` | `src/ara.js:82` |

The style path is a good template because its output is **checkable**: a palette either meets
a contrast bar or it does not. That gives her a labelled result instead of a thumbs-up.

---

## 2. Apply it to the other projects

### cods — the strongest second case
- **Decision:** what to change and how (the plan before the edit).
- **Action:** a patch/diff, then a build.
- **Outcome signal, already free:** build pass/fail, lint, typecheck, which files it touched.
- **Correction signal, already free:** his edit of the agent's output. A diff between what cods
  wrote and what ended up committed is the richest signal in the account — it says *how* he
  thinks, not just *that* he disagreed.
- **Proposed:** `askAra` before the patch, `reportOutcome` with `{returned: 'patch|plan',
  route, stored: <files touched>}` after the build, and `sendVerdict` with `correctedTo` = his
  final version.

### TEW — the decision is already made for it
- **Decision:** answer from truth, or generate.
- **Action:** a truth pair, or generation.
- **Outcome, already recorded:** truth layer, whether verified, audit rows.
- **Correction:** ratifying or killing a principle, promoting a provisional truth.
- **Proposed:** `sendVerdict` on the promotion/ratification act, `correctedTo` = the edited pair.
  This is the cheapest one to wire because the verdict is already a discrete act in the UI.

### truth — the promotion loop is the curriculum
- **Decision:** is this candidate good enough to promote.
- **Action:** promotion.
- **Outcome:** later reads, whether it survived, whether it was corrected.
- **Proposed:** she already helps curate memory (§12 of AGENTS.md); this is `reportOutcome`
  on promotion and `sendVerdict` on correction, giving her the survival curve of her own calls.

### ARA herself
- **Decision:** her move and route.
- **Outcome:** what the run produced (already reported).
- **Correction:** his verdict (already the `sendVerdict` route).
- **Proposed:** nothing new. She is already the accumulator; what is missing is *volume and
  variety* of rows from the other surfaces, which is what the three above provide.

---

## 3. "Developmental programming logical outcomes"

The phrase points at something the four beats do not say on their own: you do not just want to
know whether a decision was right, you want her to learn **how you decide while building**.

Three signals capture that, and all three come from work you already do:

1. **The shape of the ask.** What you said, verbatim, and what was ambiguous in it. You already
   rephrase when the agent missed; the rephrase is the lesson.
2. **What was done.** The diff or the plan, not the prose around it.
3. **What you changed.** Your edit, your revert, your "no, not like that". This is the label.

With those, a row stops being "was this correct" and becomes "when he asks in this shape, this
is the correction he makes", which is the thing worth retrieving on the next similar ask. Mind
already has the retrieval half — `learnHint` feeds stored hints into the next turn's context
(`src/index.js`, `withLearned`) — so the missing half is honest labelling from the surfaces
that produce code.

**Decided 2026-11-16 — his call, not a proposal:** his edits count as a verdict
**automatically**, and the diffs those verdicts rest on produce **candidate rows** that are
promoted only once they survive. That is the truth ladder applied to his own work: nothing is
taught as a rule the first time he touches it, and nothing is thrown away for being early.

What "survive" has to mean, concretely, to be worth writing:
- survived one build + one verification without being touched again, **or**
- he changed it and then left the changed version alone through the next round.

A formatting-only diff is not a correction of logic; it should either be excluded from the
diff comparison or counted as survival, not as disagreement. This is the one part that needs
care when cods is wired, because a reformat looks identical to a fix at the level of a diff.

---

## 4. Order I would do it in

1. **cods** — biggest signal, because a diff is a comparable artefact.
2. **TEW ratification** — smallest change, a discrete act already in the UI.
3. **truth promotion** — closes the loop she already half-owns.

Each is the same two calls at the point where the work happens. None of it needs a new service
or a new store; the row lands in her journal through `/outcome` and `/feedback`.
