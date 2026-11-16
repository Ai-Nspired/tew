Copied from the `truth` repository (`dno-luigi/truth`) on 2026-11-14.

In the repo these live at:
  patches/2026-11-14-audit-record/worker.js   (wrangler `main` candidate)
  patches/2026-11-14-audit-record/README.md
  test/audit-record.test.mjs                  (imports ../patches/2026-11-14-audit-record/worker.js)

Base is `patches/2026-11-12-op-candidate/index.js` — the source of the version
deployed as truth v `5fc78afd-9e44-48a5-b6d3-30488255f047` — not the v26
`bundle/`, which the repo says must never be regenerated from `src/parts/`.

Nothing here is deployed and `wrangler.jsonc` still points at the 2026-11-12
directory’s `worker.js`, which does not exist in that directory (only
`index.js`). Deploying from the repo as-is would fail before this patch.
