---
title: "feat: v0.5 conformance vectors — sessions, addressed entries, delivery honesty"
date: 2026-08-11
type: feat
issue: https://github.com/autnmy/ma2h-protocol/issues/27
---

# feat: v0.5 conformance vectors — sessions, addressed entries, delivery honesty (#27)

## Summary

Land the remaining v0.5 conformance surface per spec §12's three-class model: deterministic `dp-*`
signature fixtures for the three §9.8 entry contexts (`message`/`response`/`receipt`), tamper/replay
negatives, behavioral downstream-proof obligation vectors for the §12 inter-agent list (sessions,
claim semantics, stream liveness, bounce/delivery honesty, addressed-submit honesty,
resolver/addressee duties), a `pa-002` prose-audit set for the v0.5 MUSTs, three `sv-*`
resolve-request gap-fills, and a `conformance/README.md` coverage map tying every v0.5 obligation to
a vector id or prose-audit entry.

## Problem Frame

PR #29 (issue #25) merged `spec/v0.5.md` + `schema/v0.5/` with 38 schema-validation vectors
(sv-017..054) and version-aware runner routing. The §12 conformance surface for v0.5 is otherwise
unfilled: no deterministic fixtures pin the §9.8 signatures (worked values exist only as prose in
`examples/entry-signatures-v0.5.md`), no vectors state the downstream-proof obligations a Hub must
discharge, and the README's obligation list + coverage stop at v0.4. Issue #27 owns closing that gap.

**Lane constraint (hard):** a sibling agent works #26 (reference implementation) concurrently. This
plan may only change `conformance/vectors/**` and `conformance/README.md`. Runner branches for the
new deterministic fixtures live in `reference/src/conformance.ts` (#26's lane) — new `dp-*` ids fall
through to the runner's existing skip-with-reason path, so the union test suite stays green; the
expected wiring is documented per-fixture and in a coordination comment on #26.

## Requirements (from issue #27 + spec §12)

- R1: Deterministic signature fixtures for the three §9.8 contexts — known input → known signature,
  digest recomputed from the delivered payload, tampered `from`/`to`/payload rejected, replayed `jti`
  rejected, fresh `t`/`jti` per delivery.
- R2: Downstream-proof obligation vectors covering the full §12 inter-agent list (lease CAS,
  first-claim-wins, zombie-socket truthfulness, hold ≤ freshness, drain ownership 404/410, stream
  provisionality, bounce-on-terminal variants incl. drained-but-unacked + principal-orphan + both
  undeliverable terminals, delivery-track truthfulness, addressed-ack honesty incl. the addressed-open
  destination case, destination validation + policy collapse, misroute detector, idempotent-replay
  Caller binding, resolver default + session-qualified matching, §13.4 session-qualified addressee
  check, attested-from qualifier equality, 0.4 session-less drain isolation).
- R3: `pa-002` prose audits for the v0.5 normative MUSTs (human sign-off class).
- R4: `conformance/README.md` updated — new obligation entries + a coverage map: every v0.5 MUST maps
  to a vector id or a prose-audit entry.
- R5: Reference `npm test` stays green over the union (new sv vectors execute and pass now; new dp/pa
  vectors skip gracefully until #26 wires the deterministic branches).
- R6: Fill genuine schema-validation gaps found while building the map (resolve-request conditional
  branches not exercised by #25).

## Key Technical Decisions

- **Pin the worked-example values, verified independently.** The `dp-011/013/016` fixture values come
  from `examples/entry-signatures-v0.5.md` (landed with #25) but are re-derived from scratch with a
  standalone JCS+HMAC script before being baked in — a wrong pinned value would brick every future
  conformant implementation against the vectors. New values (response-less `resolved_at: null`
  context, second-delivery signature) are computed the same way.
- **Fixture shapes mirror the existing dp conventions** so #26 can wire runner branches mechanically:
  positives mirror dp-001/005/008 (`test_key`, `signature_alg`, payload block, `signed_context`,
  `canonical_jcs`, `header`, `v1` + recompute obligation); tamper negatives mirror dp-006/009 (honest
  control first — so a reject-everything verifier can't vacuously pass — then tampered variants that
  MUST fail with a signature mismatch, reconstruction from the received entry). Multi-axis tampering
  uses a `tampered_entries` array of `{reason, entry}` (dp-006 had a single axis; the entry contexts
  have three).
- **Behavioral obligations grouped by theme, dp-010 style** (numbered sub-obligations in one
  `obligation` string per vector) rather than one vector per §12 clause — keeps ids stable and the
  README map readable while every clause stays individually numbered and auditable.
- **New sv vectors only where a real gap exists.** #25's sv-017..054 cover the §12 schema-validation
  list; duplicating them adds noise. The one genuine gap found: `resolve-request.schema.json`'s
  conditionals are exercised only on the `answered` branch (sv-041/042) — the `else`-branch negative
  (value on `declined`), the checklist-on-ask negative, and a `completed`+checklist positive are
  missing.
- **`pa-002` is a new file, not an extension of `pa-001`** — pa-001 is the v0.3/v0.4 audit set;
  keeping v0.5 MUSTs in their own file keeps the per-version sign-off scope crisp and avoids churning
  a frozen artifact.

## Implementation Units

### U1. Deterministic value derivation harness (scratchpad)

**Goal:** Independently verify the three worked-example signatures and derive the new deterministic
values before any fixture is written.
**Requirements:** R1.
**Files:** scratchpad script only (not committed); values land in U2 fixtures.
**Approach:** Replicate `canonicalize()` (RFC 8785 JCS for the fixture value domain) + node `crypto`
HMAC-SHA256/base64url in a standalone script. Verify: message/response/receipt digests + `v1`s from
`examples/entry-signatures-v0.5.md`. Derive: `{"response":null,"state":null}` digest + `v1` for the
response-less task context (`resolved_at: null`); the second-delivery `v1` (fresh `t`/`jti`, same
context otherwise); sanity-check each tamper variant actually diverges the canonical bytes.
**Test scenarios:** script output must reproduce all six pinned example values byte-for-byte
(3 digests + 3 `v1`s); any mismatch is a STOP (a #25 examples bug to raise on #26, not to copy).
**Verification:** printed values match the examples doc; new values are stable across two runs.

### U2. Deterministic §9.8 signature fixtures (dp-011..dp-018)

**Goal:** Executable-grade fixtures for the three entry contexts + negatives + freshness.
**Requirements:** R1. **Dependencies:** U1.
**Files:** `conformance/vectors/dp-011-entry-message-signature.json`,
`dp-012-entry-message-tamper-invalid.json`, `dp-013-entry-response-signature.json`,
`dp-014-entry-response-cross-session-replay-invalid.json`,
`dp-015-entry-response-null-resolved-at-signature.json`, `dp-016-entry-receipt-signature.json`,
`dp-017-entry-receipt-tamper-invalid.json`, `dp-018-entry-redelivery-fresh-signature.json`.
**Approach:** dp-011/013/016 positives (context, canonical JCS, digest pre-image + digest, header,
`v1`, delivered entry, reconstruction rules in `description`/`obligation`); dp-012 tampers
`from`/`to`/payload on the message entry; dp-014 replays the response entry to a different session of
the same principal (reconstructed `to` diverges) + payload tamper; dp-015 pins the §9.8
`resolved_at: null` reconstruction for a response-less task Response; dp-017 tampers `prior` (the
seen-ness lie), `in_reply_to` rebind, and `to` redirect on the receipt; dp-018 pins two deliveries of
one entry with distinct `t`/`jti` → distinct `v1`s (per-delivery re-signing) + replayed-`jti`
rejection obligation. Each carries the expected runner wiring in its `obligation` for #26.
**Patterns to follow:** dp-001/dp-005 (positive), dp-006/dp-009 (tamper), `test_key`
`ma2h-test-secret-key-0123456789ab`.
**Test scenarios:** all pinned values reproduce under the U1 harness; tampered variants fail (honest
control passes first); JSON parses; ids/filenames consistent.
**Verification:** `npm test` in `reference/` — new dp ids skip with the runner's
no-executable-check reason (never fail), and the suite stays green.

### U3. Behavioral downstream-proof obligation vectors (dp-019..dp-024)

**Goal:** State the §12 behavioral obligations a conformant Hub must discharge, precisely enough to
write the Hub tests from.
**Requirements:** R2.
**Files:** `conformance/vectors/dp-019-session-lease-obligations.json`,
`dp-020-session-drain-claim-obligations.json`, `dp-021-stream-liveness-obligations.json`,
`dp-022-bounce-delivery-honesty-obligations.json`,
`dp-023-addressed-submit-honesty-obligations.json`, `dp-024-resolver-addressee-obligations.json`.
**Approach:** dp-010 convention (class `downstream-proof`, `ref`, numbered `obligation`). Grouping:
019 = §16 lease CAS/renewal/kill-switch/registration bounds/visibility; 020 = §8.7.1 claim semantics,
drain ownership 404/410, session-less isolation, attested-from equality, strip rule, ack keys;
021 = §8.7.2 zombie socket, reconnect-at-bound, hold ≤ freshness cross-field, stream provisionality,
§15 truthfulness split; 022 = §14.2/§7 bounce coverage (prior distinction, principal-orphan,
never-bounce kinds), auto-resolution on both undeliverable terminals, receipt dedup/no-cascade,
expired ⇒ never delivered on both tracks; 023 = §4/§8.1 destination validation + collapse rules,
addressed-ack statuses + destination snapshot (incl. the schema-inexpressible `open` case), misroute
detector, idempotent-replay Caller binding, sender-`#` symmetry, opt-in gate; 024 = §9.1/§8.8/§13.4
resolver default, session-qualified matching, resolve validation/CAS, addressee session check,
deployment-declared authz policy.
**Test scenarios:** every clause in the §12 v0.5 paragraph and the issue's scope list appears in
exactly one obligation (checked while building the U6 map); JSON parses; runner skips them.
**Verification:** U6 coverage map has no unmapped §12 clause; `npm test` green.

### U4. v0.5 prose audits (pa-002)

**Goal:** The v0.5 MUSTs that need human sign-off during spec review, in one auditable set.
**Requirements:** R3.
**Files:** `conformance/vectors/pa-002-prose-audits-v05.json`.
**Approach:** pa-001 convention (`asserts: [{ref, assert}]`), ~16 entries drawn from the v0.5 spec
text: §4 `to` grammar/validation/symmetry, §4.1 `agent.session`, §5.1 addressed-notify `queued`, §6
response-entry delivery + addressee resolution, §7 undeliverable auto-resolution, §8.0 capability
gates (opt-in default false, `inter_agent` requires `ack`, allowlist collapse, hold ≤ freshness),
§8.1 ack snapshot/misroute/idempotency scope, §8.7.1 entry kinds/ack keys/id namespaces/human
visibility, §8.7.2 stream rules, §8.8 resolve binding, §9.8 signature discipline, §10 additivity +
feature-detect, §13.4 amendments, §13.5 lateral-movement layers, §14.2 terminals, §15 per-session
presence + truthfulness, §16 lease/kill-switch/visibility.
**Test scenarios:** each assert quotes/normalizes real spec language with the right §ref; JSON
parses; runner reports skip (manual sign-off).
**Verification:** spot-check each `ref` against `spec/v0.5.md`; `npm test` green.

### U5. Resolve-request sv gap-fills (sv-055..sv-057)

**Goal:** Exercise the resolve-request schema branches #25 left uncovered.
**Requirements:** R6.
**Files:** `conformance/vectors/sv-055-resolve-request-declined-with-value-invalid.json`,
`sv-056-resolve-request-completed-checklist-valid.json`,
`sv-057-resolve-request-answered-with-checklist-invalid.json`.
**Approach:** target `v0.5/resolve-request.schema.json` via #25's version routing; sv-055 hits the
`else: not required(value)` branch, sv-057 the ask-side checklist prohibition, sv-056 the task-side
checklist positive.
**Test scenarios:** sv-055/057 expect `invalid`, sv-056 expects `valid`; all three execute and pass
in the runner now.
**Verification:** `npm test` — pass count increases by 3.

### U6. README obligations + v0.5 coverage map

**Goal:** `conformance/README.md` documents the new vectors and maps every v0.5 MUST to coverage.
**Requirements:** R4. **Dependencies:** U2–U5.
**Files:** `conformance/README.md`.
**Approach:** (1) update the v0.5 paragraph (signature obligations now landed, not future); (2)
append obligation entries 14+ describing dp-011..024 in the existing numbered-list voice; (3) add a
"v0.5 coverage map" section — a table walking the §12 inter-agent paragraph clause by clause →
class + vector id(s) (sv ids from #25 included, so the map is complete rather than delta-only);
(4) note the deterministic dp fixtures await reference wiring (#26) and are skipped-with-reason until
then.
**Test scenarios:** every §12 v0.5 clause has a row; every new vector id appears; no stale claims
about #27 being future work.
**Verification:** manual read-through against `spec/v0.5.md` §12.

### U7. Union verification + #26 coordination

**Goal:** Prove the joint gate holds and hand #26 the wiring spec.
**Requirements:** R5. **Dependencies:** U2–U6.
**Files:** none (verification + GitHub comment).
**Approach:** `npm ci`/`npm test` + `npm run typecheck` in `reference/` on the branch; confirm new sv
vectors pass, dp-011..024 + pa-002 skip, no failures. Comment on #26: the eight deterministic fixture
ids, their shapes, and the runner branches needed (mirroring dp-001/005/006/008/009 dispatch), so
whichever PR merges second can wire or follow up cleanly.
**Test scenarios:** `npm test` exit 0; skip reasons are the runner's existing strings.
**Verification:** CI green on the PR.

## Scope Boundaries

- **In:** `conformance/vectors/**` additions, `conformance/README.md`.
- **Out (lane #26):** `reference/src/**` runner branches for the new dp fixtures, `examples/**`
  changes, hub behavior itself.
- **Out (pre-existing):** the §9.2 push-context response-less `resolved_at` gap (spec §9.8 notes it
  is tracked separately); re-covering #25's sv-017..054.

### Deferred to Follow-Up Work

- Runner execution of dp-011..018 (lands with/after #26 — coordination comment carries the spec).
- Webhook delivery for v0.5 entry kinds, richer receipt events (§10 roadmap — not v0.5 obligations).

## Risks

- **Wrong pinned value** → U1 independent derivation is the gate; a divergence from the examples doc
  stops the fixture and gets raised on #26 (examples are their lane).
- **Concurrent #26 merge races** → lanes are disjoint by path; whoever merges second rebases and
  re-runs the union gate.
- **Runner assumptions drift** (#26 changes `conformance.ts` shape) → fixtures carry their own
  reconstruction rules; the coordination comment states shapes explicitly.
