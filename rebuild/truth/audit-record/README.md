# 2026-11-14 — truth holds the audit record

Not deployed. `wrangler.jsonc` still points at `patches/2026-11-12-op-candidate/worker.js`.

## What was missing

Every link in the chain carried an audit id, and nothing held one. Counsel receives
`?audit=<id>`; its link back goes to `i.nspired.cc/a/<id>`; the page asks for the
record by id. `truth` — the source of truth — had no route that stored or returned
an audit at all, so the id had nowhere to exist and every link pointed at a 404.

## What this patch does

- `POST /api/truth/audit` — stores one audit record in R2 (`TBACKED`, bucket
  `ai-nspired`) at `audits/<id>.json`. Uses the caller's id when given, otherwise
  mints a UUID. Gated by `ADMIN_KEY` in `x-admin-key`, like every other write.
- `GET /api/truth/audit/<id>` — returns the record, public like
  `provisional/query`, so a record link resolves for the person holding it.
- Ids are checked against `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` before they touch a
  key, so an id cannot walk out of the `audits/` prefix.
- The record keeps what the caller asserts — `content`, `type`, `scores`,
  `domain`, `searches`, `created_at` — plus `saved_at` and `spec_version`. Nothing
  is re-derived and no scoring is invented here.

No KV binding is added and no new namespace is created: R2 already holds the
engine's second copies, and a record is a document.

## Verified

`node --test test/audit-record.test.mjs` — 9 cases: save, minted id, read back,
miss, prefix escape, empty content, admin gate, public read, unbound bucket.

## Why the record has no clock on it

The question this patch had to answer first was *when* an audit becomes a
record. The account had already answered it twice, in code:

- truth v26 (`bundle/worker.js`) wrote every provisional answer with
  `expirationTtl: 24 * 3600` — `setProvisional`, and both branches of
  `updateProvisional`. Three writes, three day-long clocks. An answer the
  engine had reached, and a person may have kept, deleted itself overnight.
- `ai-proxy`'s `storeAudit` wrote the audit to KV `AUDITS` with
  `AUDIT_TTL: 86400 * 30` — thirty days — and, separately, to R2 with no TTL.
  So the copy behind a link had a shelf life and the bucket copy did not.

`patches/2026-11-12-op-candidate/index.js` already removed the 24-hour clocks
and left the reason in the file: *"No expirationTtl: a saved truth stays until a
person deletes it."* That is the live behaviour now, but a TTL is fixed on the
key when it is written — rows written before that deploy still expire on their
original clock, and only rewriting the key without a TTL clears it.

So: an audit record is not a provisional answer with a longer life. It is
written once, at the audit, and it does not expire. R2 has no expiry to get
wrong, which is why the record lives there and nothing here passes a TTL.
Promotion is a separate act — it decides whether an answer becomes master
truth — and it is not what makes a record persist.
