# Plan — Reference Hub: version negotiation for the v0.2→v0.3 signature break (#9)

## Goal
Close the two version-negotiation gaps the codex review of PR #8 (#7) surfaced in the reference Hub:

1. **§10 major rejection** — the Hub MUST reject a message whose **major** it doesn't recognize with
   `version_not_supported` (400). Today it never checks the major (relies on the schema's `^0\.\d+$`).
2. **Pre-v0.3 push parity** — the Hub signs every pushed Response with the v0.3 payload-bound
   `signed_context`. A message submitted as `0.2` (the v0.3 schema still accepts any `0.x`) yields a
   Response a real v0.2 agent rejects (it reconstructs the old 9-field context → different canonical
   string). The Hub MUST reject/negotiate **pre-0.3 push**; **pull is unaffected** (pull responses aren't
   signature-verified, §8.2).
3. **Spec note** — make the push-parity requirement normative in §10 (+ a §9.2 cross-ref).

## Approach (minimal, one place)

### `reference/src/hub.ts`
- Add version constants: `SUPPORTED_MAJOR = 0`, `IMPLEMENTED_MINOR = 3`, `HUB_VERSION = "0.3"`.
- Add `private negotiateVersion(message)`, called as the **first line of `submit()`** (before
  `validateMessage`, so an unknown major returns `version_not_supported` rather than a generic schema
  `validation_error`):
  - Parse `^(\d+)\.(\d+)$` from `a2h_version` defensively; if it doesn't match, return and let schema
    validation produce `validation_error` (malformed envelope).
  - `major !== SUPPORTED_MAJOR` → throw `HubError("version_not_supported", …)` (§10).
  - `minor < IMPLEMENTED_MINOR` **and** the message carries a **push** callback (reuse `callbackOf`) →
    throw `version_not_supported` ("push callbacks require ≥ 0.3 … use pull, or upgrade"). Pull falls
    through and is accepted.
- **`lifecycle.ts:41` stays unchanged.** Rejecting pre-0.3 push at submit means every message that reaches
  `deliver()`'s push path is ≥ 0.3, so the echoed `a2h_version` already matches the signed shape. A pre-0.3
  **pull** Response still echoes its own version — fine, pull is unsigned and transport-trusted.

### `spec/v0.3.md` §10 (+ §9.2 cross-ref)
- Add a bullet under §10: the v0.3 signature break requires **push version parity** — a v0.3 Hub's pushed
  Response can only be verified by a v0.3+ agent, so a Hub MUST reject (or negotiate) a pre-0.3 message that
  requests a **push** callback (`version_not_supported`); **pull** remains compatible (unsigned per §8.2).
- One-line cross-ref in §9.2 pointing to the §10 push-parity rule.

### `conformance/vectors/pa-001-prose-audits.json`
- Add a `§10` prose-audit assert: major rejection + push parity are downstream-proof obligations.

### `reference/test/version-negotiation.test.ts` (new)
- `1.0` (unknown major) → `submit` throws `version_not_supported`.
- `0.2` ask with a **push** callback → throws `version_not_supported`.
- `0.2` ask with a **pull** callback → accepted (`ack.status === "open"`).
- `0.3` push → accepted (regression guard).
- malformed `a2h_version` ("x") → still a schema `validation_error`, not `version_not_supported`.

### `CHANGELOG.md`
- `## Unreleased` note: reference Hub now enforces §10 major rejection + pre-0.3 push parity.

## Non-goals
- **Not** loosening the message schema's `^0\.\d+$` pattern — the Hub-level major check runs before schema
  validation, so the schema stays the documented 0.x boundary.
- **Not** changing the lifecycle version echo or the signing shape.

## Verification (`verification_harness: none`)
`cd reference && npm run typecheck && npm test` — new test passes, all existing tests + conformance vectors
stay green. (No browser/xcode surface.)

## Merge-coordination note
Sibling #10 (numeric `payload_sha256` vectors) also touches `spec/v0.3.md` §9.2, `CHANGELOG.md`,
`conformance/README.md`, and `pa-001`. Keep edits here append-style/minimal so whichever PR merges second
rebases trivially.
