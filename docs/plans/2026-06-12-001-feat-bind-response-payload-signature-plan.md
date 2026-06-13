---
title: "feat: Bind the Response payload into the A2H detached signature (v0.3)"
type: feat
status: active
date: 2026-06-12
origin: "GitHub issue autnmy/a2h-protocol#7"
---

# feat: Bind the Response payload into the A2H detached signature (v0.3)

**Target repo:** `autnmy/a2h-protocol` (this plan lives in that repo; all paths below are repo-relative to it).
**Branch:** `7-bind-response-payload-signature` (cut from `origin/main`, HEAD `262ef3e`).

---

## Summary

The A2H detached Response signature (spec §9.2) binds a 9-field `signed_context` of metadata but **not** the
response payload an agent consumes — `response.value`, `response.comment`, `response.actor`,
`response.edited`, and the round-tripped `state`. For a `select`/`input` ask the *resolution* is signed but
the *answer value* is not, so a TLS-terminating proxy or MITM can flip `value` (e.g. `hold`→`ship`) and the
agent's `verifyResponse` still returns `ok: true`. This plan binds a canonical digest of the payload —
`payload_sha256` — into `signed_context`, closing the gap end-to-end (transport-independent). Because it
changes the signed canonical structure, it is a **breaking** change and ships as protocol **v0.3** (decision
already made by the owner per spec §10 / GOVERNANCE.md §4.4 "breaking changes bump the version").

This is one cohesive PR: spec + schema + reference + vectors + example must move together, or the conformance
signature fixture and any conformant peer diverge.

---

## Problem Frame

- **What's wrong:** `SIGNED_FIELDS` (`reference/src/signing.ts`) = `a2h_version, callback_url, id, in_reply_to,
  jti, resolution, resolution_id, resolved_at, t`. The agent (`reference/src/agent.ts` `onResume`) verifies a
  signature over exactly those fields, then acts on `response.value` / opens `state` — neither of which the
  signature covers. The Hub (`reference/src/hub.ts` `deliver`) signs the same 9 fields.
- **Why HTTPS isn't enough:** §9.2's whole purpose is *application-layer* integrity independent of transport;
  the threat is a terminating proxy or compromised hop that re-serializes the body. HTTPS protects the wire
  hop, not the proxy.
- **Why it's a breaking change:** adding a field to the JCS-canonicalized `signed_context` changes the signed
  byte string. A v0.2 verifier and a v0.3 signer compute different canonical strings → signature mismatch.
  The §10 "ignore unknown fields" robustness rule governs *envelope parsing*, not signature canonicalization,
  so no minor-version scheme keeps old verifiers interoperating across this. Hence the version bump.

---

## Requirements

- **R1.** Bind the agent-consumed Response payload into the detached signature so tampering with
  `response.value`, `response.comment`, `response.actor`, `response.edited`, `response.resolved_at`, or
  `state` causes verification to fail. (issue #7)
- **R2.** The agent MUST verify by **recomputing** the digest over the payload it actually received — never by
  trusting a digest value handed to it — so a forged payload cannot carry a matching digest.
- **R3.** Ship as protocol **v0.3**: new `spec/v0.3.md` and `schema/v0.3/` (per-version snapshots, v0.2 left
  intact as history); reference impl + conformance vectors move to v0.3 in place (they track the current
  version — both are flat, not version-snapshotted).
- **R4.** Satisfy the AEP change process (GOVERNANCE §4): the PR touches the **spec**, the **schema**, and at
  least one **example**.
- **R5.** Prove it with conformance vectors: a positive payload-bound round-trip and a **negative** that a
  tampered `response.value` (metadata intact) fails verification.
- **R6.** Keep the `spec/v0.3.md` diff vs `spec/v0.2.md` minimal and surgical (copy + targeted edits) so
  reviewers can diff the two files.
- **R7.** Preserve DCO: every commit carries `Signed-off-by: Tim Layton <laytontm@gmail.com>` (CI `dco` job).

---

## Key Technical Decisions

### KTD1 — `payload_sha256` definition

Add a tenth field `payload_sha256` to `signed_context`, defined normatively as:

```
payload_sha256 = lowercase-hex( SHA-256( JCS( { "response": <R.response or null>,
                                                 "state":    <R.state or null> } ) ) )
```

- The digest input is a **fixed-key wrapper object** `{ "response", "state" }` so "absent response" vs
  "absent state" are unambiguous (each is `null` when absent), and the existing `canonicalize()` (RFC 8785
  JCS) serializes it.
- It binds the **entire** `response` detail object (value, edited, actor, resolved_at, comment) and the
  **entire** `state` blob — not a cherry-picked field list — so future detail fields are auto-bound.
- **Encoding:** lowercase hex (unambiguous, conventional for a `_sha256` field; it's a JSON string value
  either way). The existing `v1` signature stays base64url; only the new digest field is hex.
- `resolution`, `resolution_id`, and `resolved_at` remain top-level signed fields (resolved_at is thus bound
  both top-level and inside the digest — harmless). `defaulted` is already constrained by the schema to
  correlate with the signed `resolution: expired` + the now-bound `actor`, so it need not be a separate
  signed field; note this in the spec rationale rather than expanding scope.

### KTD2 — `buildSignedContext` stays a pure assembler; a new `computePayloadSha256` does the work

- `buildSignedContext(parts)` continues to be a pure builder and simply passes through a `payload_sha256`
  string field. This keeps the conformance/test call `buildSignedContext(vector.signed_context)` working
  unchanged (the stored `signed_context` already contains the digest).
- Add an exported `computePayloadSha256(response?: ResponseDetail, state?: JsonObject): string` to
  `reference/src/signing.ts`. **Callers compute the digest from the live payload and pass the result into
  `parts.payload_sha256`** — this is where R2's "recompute, don't trust" property is enforced:
  - `hub.ts deliver` computes it from the `response` it is about to send.
  - `agent.ts onResume` computes it from the `response`/`state` it **received**, before verifying.
- Rationale for not having `buildSignedContext` compute internally: mixing "pre-computed from a stored vector"
  with "computed from a live payload" in one function is muddy; a separate pure compute fn keeps both the
  vector fixture path and the live verify path clear.

### KTD3 — Versioning surfaces

`A2hVersion` is the template-literal type `` `0.${number}` `` (`reference/src/types.ts:6`), so `"0.3"` is
already type-valid — **no type change**. Bump only the runtime/active-version surfaces:
`reference/src/envelope.ts` (`SCHEMA_DIR` + `BASE` → `schema/v0.3/`), the default `a2h_version` values the
reference emits, the cosmetic `"…in v0.2"` string in `hub.ts:133`, doc-comment in `types.ts:1`, and the help
URLs in `reference/bin/a2h.ts`. Schema-validation vectors then resolve against `schema/v0.3/` via
`envelope.ts`.

### KTD4 — JCS over arbitrary payload: number-formatting caveat

`signed_context` was all-strings, where the reference `canonicalize()` is byte-exact with JCS. The payload can
contain **numbers** (in an `input`-mode `value` object or in `state`), where the reference's minimal
`canonicalize()` (`JSON.stringify` for numbers) is **not** full RFC 8785 §3.2.2.3 number formatting. The spec
already says production impls SHOULD use a vetted JCS library; §9.2 must restate that the `payload_sha256`
input is JCS and that conformant signers/verifiers MUST agree on number formatting. Keep the test-vector
payloads to strings/booleans/nested-strings so the deterministic fixture stays byte-exact under the reference
canonicalizer. Capture the "vetted JCS lib for numeric payloads" follow-up as a polish/risk note for the
re-vendor (oh-hai) too.

### KTD5 — Vectors and reference are flat (track current version); spec & schema are snapshotted

`conformance/vectors/` and `reference/src|bin/` have no per-version subdirs → update them **in place** to
v0.3. `spec/` and `schema/` snapshot per version → **add** `spec/v0.3.md` and `schema/v0.3/`, leaving v0.2
files untouched as history.

---

## High-Level Technical Design

Signer (Hub) and verifier (Agent) must compute the **same** `payload_sha256`; the agent computes it from the
bytes it received, so tampering diverges the digest:

```
Hub.deliver(response)                          Agent.onResume(received_response, sigHeader)
  d = computePayloadSha256(                       d' = computePayloadSha256(
        response.response, response.state)              received.response, received.state)
  sc = buildSignedContext({ …9 fields…,           sc = buildSignedContext({ …9 fields…,
        payload_sha256: d })                            payload_sha256: d' })
  header = signResponse(sc, key)                  verifyResponse(sc, sig.v1, key)
        │                                                │
        └── A2H-Signature: t,jti,v1 ───[ proxy may tamper response.value ]──▶ d' ≠ d
                                                         └── canonical(sc) differs ⇒ HMAC mismatch ⇒ ok:false
```

Untampered: `d' == d` → canonical strings match → `ok: true` (unchanged behavior for honest deliveries).

---

## Implementation Units

### U1. Add `payload_sha256` to the signed context + a `computePayloadSha256` helper

- **Goal:** Extend the signed structure and provide the digest function. No callers wired yet (keeps the diff
  reviewable; U2 wires them).
- **Requirements:** R1, R2 (mechanism), KTD1, KTD2.
- **Dependencies:** none.
- **Files:**
  - `reference/src/signing.ts` — add `"payload_sha256"` to `SIGNED_FIELDS` (alphabetical JCS order is handled
    by `canonicalize`, but keep the array in spec order); add `payload_sha256: string` to `SignedContextParts`
    and pass it through in `buildSignedContext`; add and export `computePayloadSha256(response?, state?)`
    using `createHash("sha256")` over `canonicalize({ response: response ?? null, state: state ?? null })`,
    returning lowercase hex.
  - `reference/src/types.ts` — add `payload_sha256: string` to `interface SignedContext` (after `t` or in
    field order; canonicalization sorts regardless).
  - `reference/test/signing.test.ts` — unit tests for `computePayloadSha256` (see scenarios).
- **Approach:** `computePayloadSha256` imports `canonicalize` (already in the module). Wrapper object with
  `null` for absent members. Do not change `signResponse`/`verifyResponse` signatures — they already operate
  on the assembled `SignedContext`, which now includes `payload_sha256`.
- **Patterns to follow:** existing `createHmac` usage and `canonicalize` import in `signing.ts`.
- **Test scenarios:**
  - Happy: `computePayloadSha256({value:"hold",actor:"human:alice",resolved_at:"…",edited:false}, undefined)`
    returns a stable 64-char lowercase-hex string; identical inputs → identical digest.
  - Edge: both args `undefined` → digest of `{"response":null,"state":null}` (stable, non-empty).
  - Edge: `state` present, `response` absent → differs from the both-absent digest.
  - Sensitivity: flipping `value` `"hold"`→`"ship"` changes the digest; flipping `actor` changes it; changing
    a `state` key changes it.
  - `buildSignedContext` passes `payload_sha256` through verbatim (assembler purity).

### U2. Wire the digest into the Hub signer and Agent verifier (and CLI/conformance)

- **Goal:** Hub signs over the payload digest; agent recomputes from what it received and verifies. This is
  the actual fix.
- **Requirements:** R1, R2.
- **Dependencies:** U1.
- **Files:**
  - `reference/src/hub.ts` (`deliver`, ~247) — compute `payload_sha256` from `response.response` /
    `response.state` and include it in the `buildSignedContext({…})` parts.
  - `reference/src/agent.ts` (`onResume`, ~66) — compute `payload_sha256` from the **received**
    `response.response` / `response.state` and include it in the reconstructed parts, before `verifyResponse`.
    Note: digest is computed over the sealed `state` blob as received (verification of the seal still happens
    after, unchanged).
  - `reference/bin/a2h.ts` (`sign`/`verify`, ~70/80) — these read a `signed_context.json`; if it already
    contains `payload_sha256`, `buildSignedContext` passes it through (no change needed). Confirm the CLI
    still round-trips; update the `sign`/`verify` usage docs if helpful.
  - `reference/src/conformance.ts` (~52) — the dp-001 runner reads `signed_context` (which now contains
    `payload_sha256`) directly; verify it still reproduces `canonical`/`v1`. For the new payload-binding
    obligation, the unit test in U6 carries the recompute-from-payload proof.
- **Approach:** The security property lives entirely in agent.ts recomputing from received bytes. Add a brief
  code comment at the agent call site pointing to §9.2 and issue #7.
- **Patterns to follow:** the existing `buildSignedContext({…})` call shapes in `hub.ts` and `agent.ts`.
- **Test scenarios:**
  - Integration (round-trip): Hub signs a Response with `value:"hold"`; agent with the matching key verifies
    `ok:true` and acts once.
  - Integration (tamper): after signing, mutate the delivered `response.value` to `"ship"` (signature header
    unchanged) → agent `onResume` returns `acted:false, reason:"signature: signature mismatch"`.
  - Integration (tamper actor/comment/state): same mutation on `actor`, `comment`, and a `state` key each →
    verification fails.
  - Regression: an honest unmodified push still verifies and acts (no false negatives).

### U3. Bump the reference impl + active wiring to v0.3

- **Goal:** Reference emits/validates v0.3.
- **Requirements:** R3, KTD3, KTD5.
- **Dependencies:** U5 (schema/v0.3 must exist for `envelope.ts` to point at it).
- **Files:**
  - `reference/src/envelope.ts` — `SCHEMA_DIR` (`../../schema/v0.2/`→`v0.3/`) and `BASE`
    (`…/schema/v0.2/`→`v0.3/`).
  - `reference/src/types.ts:1` doc comment; default `a2h_version` values the reference produces (grep for
    emitted `"0.2"`).
  - `reference/src/hub.ts:133` — cosmetic error string `"…in v0.2"`→`"…in v0.3"`.
  - `reference/bin/a2h.ts` (~128–131) — help/`docs` URLs `spec/v0.2.md`→`spec/v0.3.md`,
    `schema/v0.2/`→`schema/v0.3/`.
- **Approach:** `grep -rn '0\.2\|v0\.2' reference/src reference/bin` and bump every occurrence that denotes
  the *active* protocol version. Leave any genuinely historical reference (there shouldn't be one in
  `reference/`) alone.
- **Test scenarios:**
  - Typecheck passes (`A2hVersion` template type already accepts `"0.3"`).
  - A reference-emitted envelope validates against `schema/v0.3/message.schema.json` (the `^0\.\d+$` pattern
    accepts `0.3`).
  - `Test expectation:` covered by U6's full-suite run; no new dedicated test file.

### U4. Author `spec/v0.3.md` + CHANGELOG entry

- **Goal:** Normative spec for the change.
- **Requirements:** R3, R4 (spec leg), R6, KTD1, KTD4.
- **Dependencies:** none (can precede code; pairs with U6 for the fixture).
- **Files:**
  - `spec/v0.3.md` — copy `spec/v0.2.md`; then surgical edits only:
    - Header/version line and the §1/§4 `a2h_version` table cell + example envelopes (~136, ~254, ~328):
      `"0.2"`→`"0.3"`.
    - §9.2: add `payload_sha256` to the `signed_context` field list and a normative paragraph defining it per
      KTD1 (wrapper object, JCS, lowercase-hex SHA-256), stating the Hub MUST include it and the agent MUST
      **recompute** it from the received payload and reject on mismatch; restate the JCS number-formatting
      requirement (KTD4); note `defaulted` is already constrained (KTD1 rationale).
    - §10: add a line noting v0.3 binds the response payload into the signature (breaking vs v0.2).
    - Appendix A worked example: show a Response with its `payload_sha256` and the resulting header (see U7).
  - `CHANGELOG.md` — new `## 0.3 (2026-06-12) — Draft` section: Breaking (signature now binds the response
    payload via `payload_sha256`; v0.2 verifiers reject v0.3 signatures and vice-versa) + Added (the field,
    the negative conformance vector).
- **Approach:** Keep prose style consistent with v0.2.md. Minimize non-§9.2 churn so a `git diff
  --no-index spec/v0.2.md spec/v0.3.md` reads as a focused change.
- **Test scenarios:** `Test expectation: none — spec prose.` Validated by the `prose-audit` lens in review
  and the SKILL.md/frontmatter CI step (unaffected, but confirm the build doesn't parse spec files).

### U5. Snapshot `schema/v0.3/`

- **Goal:** v0.3 schema snapshot.
- **Requirements:** R3, R4 (schema leg), KTD5.
- **Dependencies:** none.
- **Files:** `schema/v0.3/` — copy all five files from `schema/v0.2/`; rebump `$id`, internal `$ref` URLs, and
  `title` strings `…/schema/v0.2/…`→`…/schema/v0.3/…` and `(v0.2)`→`(v0.3)`. The `a2h_version` `^0\.\d+$`
  pattern is unchanged (already accepts 0.3). No structural schema change is required — `payload_sha256` lives
  in the detached signature context (conveyed via the `A2H-Signature` header), not in the Response *body*
  schema. (Decision: do **not** add `payload_sha256` to `response.schema.json`; document in U4 that the signed
  context is a header-borne structure, consistent with v0.2 where `signed_context` had no body schema.)
- **Approach:** `cp -r schema/v0.2 schema/v0.3` then `sed`/edit the `$id`/`$ref`/`title` version tokens; verify
  with a grep that no `v0.2` token remains in `schema/v0.3/`.
- **Test scenarios:** the schema-validation conformance vectors (U6) resolve and pass against `schema/v0.3/`
  via `envelope.ts` (U3).

### U6. Update conformance vectors + signing tests (the proof)

- **Goal:** Deterministic positive fixture regenerated for v0.3; negative tamper vector added; version bumped
  across vectors.
- **Requirements:** R1, R5, KTD5.
- **Dependencies:** U1, U2 (for `computePayloadSha256`/regeneration), U3 (schema path).
- **Files:**
  - `conformance/vectors/dp-001-signature.json` — bump `signed_context.a2h_version` `"0.2"`→`"0.3"`; add the
    computed `payload_sha256` to `signed_context`; add a `payload` block (`{response:{…}, state?:{…}}`, all
    string/boolean/nested-string values per KTD4) the digest is computed over; **regenerate** `canonical_jcs`,
    `header`, and `v1` deterministically with the reference signer (see Verification); update `description`.
  - `conformance/vectors/dp-002-payload-tamper-invalid.json` (new) — `class: downstream-proof`, `expect`/
    `obligation`: a Response whose `response.value` is flipped relative to the signed `payload_sha256` MUST
    fail verification. Carry the honest `payload` + signed context + the tampered `value` so a Hub/agent can
    reproduce `ok:false`.
  - All vectors carrying `a2h_version: "0.2"` (the `sv-*` set + dp-001) → `"0.3"`.
  - `conformance/README.md` — header `(v0.2)`→`(v0.3)`; if it lists vectors, add dp-002.
  - `reference/test/signing.test.ts` — add the recompute-from-payload tests (positive + tampered value/actor/
    comment/state), asserting `verifyResponse` ok/not-ok accordingly; keep the existing dp-001 reproduction
    test green against the regenerated fixture.
- **Approach:** Regeneration is an execution-time step — compute the new `payload_sha256`, `canonical_jcs`, and
  `v1` by running the reference signer on the fixture's `signed_context` + `payload`, then paste the outputs
  into the JSON (do not hand-compute). The `npm test` run (which executes vectors) is the gate.
- **Test scenarios:**
  - dp-001 reproduction test: `signResponse(buildSignedContext(vector.signed_context)).canonical ==
    vector.canonical_jcs` and `v1 == vector.v1` (now including `payload_sha256`).
  - dp-002: honest payload verifies; tampered `value` → `ok:false` `"signature mismatch"`.
  - Existing replay-window / declined-resolution tests still pass (regression).

### U7. Worked example touching `examples/` (AEP requirement)

- **Goal:** Satisfy GOVERNANCE §4 "at least one example" and give implementers a concrete payload-bound
  signature.
- **Requirements:** R4 (example leg).
- **Dependencies:** U1 (for a real digest value), U4 (Appendix A).
- **Files:**
  - `examples/` — read the existing files first; update the most relevant (or add a small
    `examples/response-signature-v0.3.md`) showing a Response, its computed `payload_sha256`, the
    `signed_context`, and the resulting `A2H-Signature` header, plus a one-line note that the agent recomputes
    the digest from the received payload.
  - `spec/v0.3.md` Appendix A — mirror the same worked example (folded into U4's edit).
- **Approach:** Reuse the dp-001 fixture values so the example and the conformance vector agree byte-for-byte.
- **Test scenarios:** `Test expectation: none — documentation/example.` Cross-check the example's digest/header
  equal the regenerated dp-001 values.

---

## Verification

CI-equivalent gate (no constitution in this repo; `verification_harness` defaults to none/heuristic — not
browser/xcode). Run from the repo root, `cd`-ing into `reference/` where noted:

1. `ruby scripts/check-skill-frontmatter.rb` (CI step 1).
2. `cd reference && npm ci && npm run typecheck`.
3. `cd reference && npm test` — runs reference unit tests **and** the conformance vectors; dp-002 must show
   the tampered value failing, dp-001 must reproduce its regenerated `v1`.
4. `grep` sanity: no `v0.2` tokens remain in `schema/v0.3/` or in active `reference/` wiring; `spec/v0.2.md`
   and `schema/v0.2/` are unchanged.
5. Every commit carries `Signed-off-by:` (CI `dco` job; commit with `-s`).

The change is complete when the full suite is green, the tamper vector demonstrably fails verification, and
the spec/schema/example legs are all present (AEP).

---

## Scope Boundaries

**In scope:** the v0.3 spec/schema/reference/vectors/example for `payload_sha256`; the Hub signer + agent
verifier wiring; the deterministic fixture regeneration + negative vector.

### Deferred to Follow-Up Work

- **oh-hai re-vendor (cross-repo):** `autnmy/oh-hai#31` re-vendors `server/src/a2h/` to this v0.3 commit, wires
  `payload_sha256` into the Hub's `delivery-worker.ts` signer and `scripts/agent-client.ts`
  `verifyPushedResponse`, and updates `server/src/a2h/VENDORED.md` (pin currently `0aae05c`). It is `blocked`
  on this PR merging + being taggable; update it once this lands. The umbrella launch-blocker is
  `autnmy/oh-hai#23`.
- **Vetted JCS library for numeric payloads (KTD4):** the reference `canonicalize()` is not full RFC 8785
  number formatting; payloads with numbers need a vetted JCS lib for cross-impl byte-exactness. Track as a
  reference-impl hardening follow-up (and call it out in the oh-hai re-vendor).
- **ed25519 path:** `signResponse` only implements `hmac-sha256` in this slice; the ed25519 advertised in §8.0
  is out of scope here (unchanged from v0.2).

**Out of scope / non-goals:** changing the replay-window / `jti` cache design; altering `state` sealing
(§9.3); a major version bump (1.0 stability line not crossed).

---

## Risks & Dependencies

- **Fixture drift (high-likelihood, low-severity):** hand-editing `canonical_jcs`/`v1` instead of regenerating
  → vector test fails. Mitigation: always regenerate with the reference signer (U6 Approach).
- **Missed `0.2` literal (medium):** an un-bumped active-version string ships a mixed-version reference.
  Mitigation: the U3 grep + the "no v0.2 in schema/v0.3 or active reference" check (Verification step 4).
- **Number-formatting divergence (KTD4):** only bites payloads with numbers across heterogeneous JCS impls;
  test vectors avoid numerics; tracked as deferred.
- **DCO miss:** an unsigned commit fails CI. Mitigation: `git commit -s`; if missed, `git rebase --signoff
  origin/main` then force-push.
- **`main` moves during the loop:** a co-landing PR can conflict the PR. Mitigation: re-merge `origin/main`
  promptly (predictable hotspots here are minimal — this repo isn't running the oh-hai polish-backlog
  pattern).

---

## Sources & Research

- Issue `autnmy/a2h-protocol#7` (problem statement + proposed fix).
- `reference/src/signing.ts`, `agent.ts`, `hub.ts`, `conformance.ts`, `types.ts`, `bin/a2h.ts` (current
  signing path).
- `spec/v0.2.md` §6 (Response envelope), §9.2 (Response integrity), §10 (versioning); `schema/v0.2/`;
  `conformance/vectors/dp-001-signature.json`; `conformance/README.md`.
- `GOVERNANCE.md` §4 (AEP), §5 (versioning); `.github/workflows/ci.yml` (CI + DCO gates).
- Cross-repo: `autnmy/oh-hai#23` (umbrella launch-blocker), `#31` (re-vendor, blocked on this).
