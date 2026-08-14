# @ma2h/reference

A **vendor-neutral** reference implementation and conformance harness for the
[MA2H — Multi-agent to Human Protocol](../spec/v0.5.md). Apache-2.0.

This is the standard demonstrating itself: a readable, dependency-light implementation that any party can
read, run, or mirror. **It is not tied to any Hub product** — it is the neutral yardstick that
implementations (including commercial ones) are measured against.

## What it covers

Strict TypeScript (`tsc --noEmit` clean under `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). All tests pass (212 at v0.5).

| Module | Spec | Status |
|--------|------|--------|
| `src/types.ts` | §1–§9, §13–§16 protocol domain as discriminated unions | ✅ |
| `src/canonicalize.ts` | §9.2 RFC 8785 JCS | ✅ |
| `src/signing.ts` | §9.2 Response + §9.7 directive + the three §9.8 entry signatures (reproduces `dp-001`, `dp-005`, and the `entry-signatures-v0.5` worked values) | ✅ |
| `src/state-seal.ts` | §9.3 AEAD seal/open + key-provenance guard | ✅ |
| `src/envelope.ts` | §4–§6, §13.1 validation against the schemas (ajv 2020; v0.4 + v0.5 registries) | ✅ |
| `src/lifecycle.ts` | §7 atomic compare-and-set (incl. the v0.5 checklist carry) | ✅ |
| `src/hub.ts` | §7/§8/§9 in-memory Hub: resume round-trip; §8.7/§13 mailbox; **v0.5:** §16 sessions (lease/CAS/kill-switch), §4 destination validation, §8.1 reachability snapshot, §8.7.1 session-scoped drain + entry kinds + per-kind acks, §8.7.2 provisional stream, §8.8 resolve binding, §14.2 bounce/expiry honesty | ✅ |
| `src/agent.ts` | client duties (§9.2/§9.3, §13.4 incl. v0.5 amendments) + **the §13.4/§16 bridge-loop worked example** (`runBridgeLoop`: register → drain → verify → policy → act → ack → close; distinct nonzero exit codes — auth 2 / terminal session 3, `gone`: re-register / signature 4 / operator close 5, `session_closed_by_operator`: stop, do not restart) | ✅ |
| `src/conformance.ts` | runs the conformance vectors (schema + `dp-001`/`dp-005`/`dp-006` signatures; `v0.5/`-prefixed targets) | ✅ |
| `bin/ma2h.ts` | CLI: validate (version-aware v0.4/v0.5, incl. `session`/`resolve`/`submit-ack`/`entry`) / sign / verify / run-vectors | ✅ |

The `test/roundtrip.test.ts` suite demonstrates the §2.1 ephemeral resume flow end to end
(exit → human-resolve → signed push → re-invoke → verify → open state → resume), plus first-terminal-wins,
expiry-vs-answer precedence, at-most-once delivery, submitter-bound cancel/poll (§8.4/§9.1), and AEAD
state-tamper rejection. `test/inbound.test.ts` covers the v0.4 inbound leg: the mailbox (drain/ack,
at-least-once redelivery, FIFO, expiry, isolation) and the agent's directive verification (§9.7 signature,
shape validation, addressee check, jti/id dedup with in-flight reservation). The v0.5 inter-agent leg is
covered by `test/sessions.test.ts` (§16 registry), `test/interagent.test.ts` (§4/§8.1/§8.7.1/§8.8/§14.2
routing, claims, acks, bounce, retention, resolve), `test/entry-signing.test.ts` (the §9.8 contexts pinned
byte-for-byte to `examples/entry-signatures-v0.5.md`), and `test/bridge.test.ts` (the bridge loop and its
exit-code discipline).

## Run

```bash
cd reference && npm install && npm test        # tsx + node:test (212 tests)
npm run typecheck                               # tsc --noEmit (strict)
npm run vectors                                 # execute the conformance vectors

# CLI
npm run ma2h -- validate ../examples/ask-dev-team-decision.json
npm run ma2h -- validate ../examples/message-inter-agent-ask.json   # v0.5 entry, auto-detected
npm run ma2h -- sign <signed_context.json> --key <key>
npm run ma2h -- verify <signed_context.json> --v1 <sig> --key <key>
```

`npm run vectors` executes the `schema-validation` and `downstream-proof` (signature) vectors and reports
`prose-audit` vectors as skipped (manual sign-off). The remaining §12 obligations that need more than the
in-memory Hub — SSRF egress, a concurrent CAS race harness — are future work for a production Hub.
