# @a2h/reference

A **vendor-neutral** reference implementation and conformance harness for the
[AHCP — Agent Human Coordination Protocol](../spec/v0.3.md). Apache-2.0.

This is the standard demonstrating itself: a readable, dependency-light implementation that any party can
read, run, or mirror. **It is not tied to any Hub product** — it is the neutral yardstick that
implementations (including commercial ones) are measured against.

## What it covers

Strict TypeScript (`tsc --noEmit` clean under `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). 36 tests pass.

| Module | Spec | Status |
|--------|------|--------|
| `src/types.ts` | §1–§9 protocol domain as discriminated unions | ✅ |
| `src/canonicalize.ts` | §9.2 RFC 8785 JCS | ✅ |
| `src/signing.ts` | §9.2 detached Response signature (reproduces `dp-001`) | ✅ |
| `src/state-seal.ts` | §9.3 AEAD seal/open + key-provenance guard | ✅ |
| `src/envelope.ts` | §4–§6 validation against the schemas (ajv 2020) | ✅ |
| `src/lifecycle.ts` | §7 atomic compare-and-set | ✅ |
| `src/hub.ts` + `src/agent.ts` | §7/§8/§9 in-memory Hub + client; full resume round-trip | ✅ |
| `src/conformance.ts` | runs the conformance vectors (schema + dp-001 signature) | ✅ |
| `bin/a2h.ts` | CLI: validate / sign / verify / run-vectors | ✅ |

The `test/roundtrip.test.ts` suite demonstrates the §2.1 ephemeral resume flow end to end
(exit → human-resolve → signed push → re-invoke → verify → open state → resume), plus first-terminal-wins,
expiry-vs-answer precedence, at-most-once delivery, submitter-bound cancel/poll (§8.4/§9.1), and AEAD
state-tamper rejection.

## Run

```bash
cd reference && npm install && npm test        # tsx + node:test (36 tests)
npm run typecheck                               # tsc --noEmit (strict)
npm run vectors                                 # execute the conformance vectors

# CLI
npm run a2h -- validate ../examples/ask-dev-team-decision.json
npm run a2h -- sign <signed_context.json> --key <key>
npm run a2h -- verify <signed_context.json> --v1 <sig> --key <key>
```

`npm run vectors` executes the `schema-validation` and `downstream-proof` (signature) vectors and reports
`prose-audit` vectors as skipped (manual sign-off). The remaining §12 obligations that need more than the
in-memory Hub — SSRF egress, a concurrent CAS race harness — are future work for a production Hub.
