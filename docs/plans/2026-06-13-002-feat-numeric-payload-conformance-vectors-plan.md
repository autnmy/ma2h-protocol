# Plan — Numeric-payload conformance vectors for `payload_sha256` (#10)

## Goal
Prove + pin RFC 8785 number canonicalization for the v0.3 `payload_sha256` (§9.2), so cross-language
signers/verifiers can byte-agree on a numeric `response.value`/`state`, and state the normative stance.

## Key finding (scopes this down)
The reference `canonicalize()` formats numbers with `JSON.stringify`, which **is** ECMAScript
`Number::toString` — and RFC 8785 §3.2.2.3 is *defined as* that algorithm. So the JS reference is already
byte-exact RFC 8785 for finite IEEE-754 doubles (verified: `1e-7`→`1e-7`, `1e21`→`1e+21`, `-0`→`0`,
`-0.001`→`-0.001`, `9007199254740991`→itself, keys sorted). **No `canonicalize()` rewrite is needed** — the
work is a pinned vector (so *non-JS* impls have a byte-target), the interop stance, and fixing the stale
docstring. The real interop hazard isn't formatting — it's **precision**: an integer outside ±(2^53−1)
can't round-trip through a JS double, so a JS Hub and a bignum non-JS Hub would disagree. The stance closes
that with a representability rule.

## Changes

### `conformance/vectors/dp-004-numeric-payload.json` (new, `downstream-proof`)
Pin a representative numeric payload (`response.value` = nested object with int / negative / fraction /
`1e-7` / `1e21` / max-safe-int `9007199254740991` / array; `state` with `-0.5`, nested `0`) plus:
- `payload_canonical_jcs`: the exact RFC 8785 JCS of `{response, state}` (pinned bytes).
- `payload_sha256`: `56186e18d2371cee2a6636cdab7223ff52d64cfeb5bbcba01a0b4e91b7e51dca`.

### `reference/src/conformance.ts`
Add a `dp-004` handler: `canonicalize({response, state})` MUST equal `payload_canonical_jcs` (byte-exact)
**and** `computePayloadSha256(response, state)` MUST equal `payload_sha256`. (Import `canonicalize`.)

### `reference/test/conformance.test.ts`
Assert `dp-004` is exercised and passes (mirrors the dp-001/dp-003 assertions). The `passed >= 9` floor
still holds (now ≥ 10).

### `reference/src/canonicalize.ts` (docstring only)
Update the stale "values are protocol-controlled strings" note: it now canonicalizes the signed **payload**
(`{response, state}`), which can carry numbers. Note `JSON.stringify(number)` = ES `Number::toString` = RFC
8785 §3.2.2.3 (byte-exact for finite doubles); non-JS impls MUST use a vetted JCS library; numeric values
MUST be within IEEE-754 double range (±2^53−1 integers, else carry as strings).

### `spec/v0.3.md` §9.2
Strengthen the existing "Numeric payload values MUST be canonicalized per RFC 8785 §3.2.2.3" sentence: add
the representability rule (integers outside ±(2^53−1) MUST be carried as strings, not numbers) and that
non-JS implementations MUST use a vetted JCS library (JS `Number::toString` already conforms). Append-only,
right after the existing numeric sentence — minimal footprint (no overlap with #9's §10 edit).

### `conformance/vectors/pa-001-prose-audits.json`
Add a `§9.2` assert: numeric payload canonicalization (RFC 8785 §3.2.2.3) + the ±2^53 representability rule
is a downstream-proof obligation; `dp-004` pins the bytes.

### `conformance/README.md`
Add downstream-proof obligation **#7** (`dp-004`): a numeric `{response, state}` canonicalizes to the pinned
JCS + digest, so cross-language signers prove byte-agreement.

### `CHANGELOG.md` (Unreleased → Added)
Note the numeric-payload vector + the §9.2 numeric-representability stance (#10).

## Non-goals
- No `canonicalize()` number-formatting change (already RFC 8785-correct in JS).
- Not narrowing §9.2 to string-only `response.value` — numbers stay allowed; the representability rule +
  pinned vector close the interop gap without degrading expressiveness.

## Verification (`verification_harness: none`)
`cd reference && npm run typecheck && npm test` — dp-004 passes, all existing vectors/tests stay green.

## Merge coordination
#9 already merged its shared-file edits (spec §10, pa-001, CHANGELOG Unreleased) to `main`; this branch is
cut from that `main` and appends — no conflict.
