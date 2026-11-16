# Session log: mind, 2026-11-16

The workflow, and the friction it produced. Written so the next session starts warmer.

---

## The loop we are using

1. **Decide** — I say which file, what changes and why, *before* editing.
2. **Act** — the edit, then the narrowest check that could catch it being wrong.
3. **Verify with numbers** — pixels, ratios, counts, hashes. "Looks right" is not a result.
4. **Verdict** — you say yes or no, or you change it. Your change *is* the verdict, and it
   becomes a candidate row that is promoted only if it survives (see `ara-learning-map.md` §3).
5. **Record** — the commit message carries the reason, and this file carries the friction.

The habit worth building is step 3: a number is what makes a verdict possible. "The menu
works" cannot be disagreed with; "the button is at 322px on both faces and hit-testing it
returns the button" can.

---

## What actually went wrong

### Product faults found
1. **A toast was eating taps.** `#toast` sits at the bottom centre at `z-index: 2500` and
   stayed hit-testable while invisible (`opacity: 0`). Every tap aimed at the bar's restore pin
   landed on a message that was not there. `elementFromPoint` at the pin's centre returned
   `toast`. Fix: `pointer-events: none` on it.
   *Lesson: when a control "sometimes doesn't work", look above it, not at its handler.*
2. **The card's back face is mirrored.** Measuring the back face's ellipsis while it was hidden
   gave a mirrored x, so my "fix" moved it from 321 to 278 — worse. Measuring with the face
   actually flipped showed the original order was already right.
   *Lesson: measure the state the user sees, never a hidden element's box.*
3. **A menu forgot its own target.** `openQuickMenu` set `contextMenuTargetId`, then called
   `closeCardMenu()`, which nulls it — so every item in the menu did nothing, while the menu
   itself closed correctly and looked like a hit-test problem.
   *Lesson: side-effecting helpers have to run before you set the state they clear.*
4. **A long press ended in a click.** The `touchend` after the hold produced a click that both
   dismissed the menu it had opened and flipped the card. Fixed with a 500ms grace and a
   `suppressCardClick` window.
   *Lesson: touch gestures always leave a click behind. Suppress it deliberately.*
5. **The light/dark toggle destroyed the style.** It kept `primary` and installed five greys.
   That was the actual complaint, and it was three lines of hardcoded CSS-hiding logic.

### Tooling friction (cost real time)
6. **Card markup is generated inside `script.js`**, not `index.html`. My first patch asserted on
   `index.html`, aborted before any write, and left the tree untouched — which is why the
   assert-before-write pattern is in every patch I run.
7. **`/index.html` answers 307 with an empty body**, so hashing it against the local file
   reports false staleness every time. Compare `/` or script/CSS only.
8. **The Playwright tool caps at 60s per call.** A 60s `waitForFunction` inside a call always
   times out; the work carries on in the tab, so the pattern is: start in one call, poll in the
   next.
9. **No screenshots from inside `page.evaluate`** — `page` is not in scope there. Split.
10. **`preview_open` with `mode: "browser"` must be re-issued each turn**, or the first action
    of the turn fails with "browser is still open from an earlier turn".
11. **Fetching `style.css`/`script.js` by hash needs cache-busting** (`?v=$RANDOM`); the edge
    serves the old copy for a while after deploy.

---

## Rules of thumb for next time

- Suspect the layer above before the handler below.
- Measure with the state visible; a hidden element lies about its box.
- Make the check produce a number you could be wrong about.
- Every gesture you add creates a click you did not ask for — cancel it explicitly.
- A palette is relationships, not five hex codes: derive, don't substitute.
- Say what was *not* tested. Nothing was run against a live model until the last style ask.

---

## What was verified, and what was not

- Verified live: pin drag/tap/hold, card menu hit target, quick menu, floating icons,
  theme history, palette derivation and contrast, one real style generation (`WetSlateQuarryNov`).
- Not verified: anything in cods, TEW, truth or ARA's own journal — none of it was touched.
