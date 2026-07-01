# @ma2h/reference

A **vendor-neutral** reference implementation and conformance harness for the
[MA2H — Multi-agent to Human Protocol](../spec/v0.4.md). Apache-2.0.

This is the standard demonstrating itself: a readable, dependency-light implementation that any party can
read, run, or mirror. **It is not tied to any Hub product** — it is the neutral yardstick that
implementations (including commercial ones) are measured against.

## What it covers

Strict TypeScript (`tsc --noEmit` clean under `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). All tests pass (84 at v0.4).

| Module | Spec | Status |
|--------|------|--------|
| `src/types.ts` | §1–§9, §13 protocol domain as discriminated unions | ✅ |
| `src/canonicalize.ts` | §9.2 RFC 8785 JCS | ✅ |
| `src/signing.ts` | §9.2 Response + §9.7 directive detached signatures (reproduces `dp-001`, `dp-005`) | ✅ |
| `src/state-seal.ts` | §9.3 AEAD seal/open + key-provenance guard | ✅ |
| `src/envelope.ts` | §4–§6, §13.1 validation against the schemas (ajv 2020) | ✅ |
| `src/lifecycle.ts` | §7 atomic compare-and-set | ✅ |
| `src/hub.ts` + `src/agent.ts` | §7/§8/§9 in-memory Hub + client; full resume round-trip; §8.7/§13 inbound mailbox (drain/ack) + directive verify | ✅ |
| `src/conformance.ts` | runs the conformance vectors (schema + `dp-001`/`dp-005`/`dp-006` signatures) | ✅ |
| `bin/ma2h.ts` | CLI: validate / sign / verify / run-vectors | ✅ |

The `test/roundtrip.test.ts` suite demonstrates the §2.1 ephemeral resume flow end to end
(exit → human-resolve → signed push → re-invoke → verify → open state → resume), plus first-terminal-wins,
expiry-vs-answer precedence, at-most-once delivery, submitter-bound cancel/poll (§8.4/§9.1), and AEAD
state-tamper rejection. `test/inbound.test.ts` covers the v0.4 inbound leg: the mailbox (drain/ack,
at-least-once redelivery, FIFO, expiry, isolation) and the agent's directive verification (§9.7 signature,
shape validation, addressee check, jti/id dedup with in-flight reservation).

## Run

```bash
cd reference && npm install && npm test        # tsx + node:test (84 tests)
npm run typecheck                               # tsc --noEmit (strict)
npm run vectors                                 # execute the conformance vectors

# CLI
npm run ma2h -- validate ../examples/ask-dev-team-decision.json
npm run ma2h -- sign <signed_context.json> --key <key>
npm run ma2h -- verify <signed_context.json> --v1 <sig> --key <key>
```

`npm run vectors` executes the `schema-validation` and `downstream-proof` (signature) vectors and reports
`prose-audit` vectors as skipped (manual sign-off). The remaining §12 obligations that need more than the
in-memory Hub — SSRF egress, a concurrent CAS race harness — are future work for a production Hub.
