# Manufacturing V2 — mock tests (Phase 2)

`mv2_core.js` is the standalone factory form of the same V2 module embedded in
`index.html` (`buildMV2`). `mv2_test.js` runs it against an in-memory mock
Firestore to prove the safety invariants — no live Firestore is touched.

Run:  `node mv2-tests/mv2_test.js`

Proves: moulded-basis costing + dual cost/unit; validation failure blocks with
zero writes (no legacy fallback); atomic post (production + all V2 docs or none);
deterministic safe IDs; append-only correction (originals unchanged); BOM
immutability; latest-activation-on/before-IST-date; write-allowlist guard;
disabled-by-default (1 config read, 0 writes); actual-issue + variance
(batch vs unallocated, incomplete≠zero).
