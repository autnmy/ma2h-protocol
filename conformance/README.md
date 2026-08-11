# MA2H Conformance Vectors (v0.5)

These vectors let an implementer prove conformance. **Read this first** — it states what the vectors can
and cannot verify, so green ≠ false confidence (spec §12).

## Three verification classes

Every vector declares a `class`:

| `class` | Verifies | Executable without a Hub? |
|---------|----------|---------------------------|
| `schema-validation` | wire shape: an `input` validates (or is an intentional negative) against a named schema | **Yes** — pure JSON Schema |
| `prose-audit` | a normative MUST is present and correctly scoped in the spec text | No — human sign-off during spec review |
| `downstream-proof` | a security/concurrency control behaves correctly | No — only against a conformant Hub implementation |

The security- and concurrency-critical requirements are **`downstream-proof`** by nature — a JSON Schema
cannot check a signature scheme, an SSRF guard, or a race. The spec specifies candidate controls; closure
is proven by the Hub's test suite. Do not read a green `schema-validation` run as "the P0s are closed."

## Vector format

```jsonc
{
  "id": "sv-002-notify-with-request-invalid",
  "class": "schema-validation",
  "description": "A notify carrying a request block is rejected (cross-type leakage).",
  "ref": "spec §4, §5.1",
  "target": "message.schema.json",        // schema-validation only
  "input": { /* the document under test */ },
  "expect": "invalid"                       // valid | invalid
}
```

`prose-audit` vectors carry `ref` + `assert` (the sentence a reviewer confirms). `downstream-proof`
vectors carry `ref` + `obligation` (what the Hub must demonstrate) and, where deterministic, fixtures the
Hub must reproduce (e.g., the signature vector `dp-001`).

## Running the schema-validation vectors

```bash
pnpm dlx ajv-cli@5 validate \
  -s schema/v0.4/<target> \
  -r "schema/v0.4/*.schema.json" \
  -d <input.json>
```

or load all eight schemas into any Draft 2020-12 validator and check each vector's `input` against its
`target`, asserting the declared `expect`.

**Version-prefixed targets (v0.5).** A bare `target` (e.g. `message.schema.json`) validates against
`schema/v0.4/`. A target prefixed `v0.5/` (e.g. `v0.5/inbound-message.schema.json`) validates against
the `schema/v0.5/` snapshot — swap the `-s`/`-r` paths above accordingly (nine schemas in v0.5,
including `session.schema.json`). The reference runner (`npm run vectors`) routes both automatically.
The v0.5 **signature** obligations (the §9.8 `message`/`response`/`receipt` entry contexts, worked in
[`examples/entry-signatures-v0.5.md`](../examples/entry-signatures-v0.5.md)) land as deterministic
`dp-*` fixtures with the vectors issue (#27), alongside the downstream proofs for sessions, routing,
and delivery honesty (spec §12).

## Downstream proof obligations (the Hub must discharge)

1. **Signature** — reproduce `dp-001`: JCS(`signed_context`, now incl. `payload_sha256`) → HMAC-SHA256
   with the test key → the expected `v1`, and recompute `payload_sha256` from the fixture's `payload`.
   Reject a tampered `signed_context` and a replayed `jti` within the window.
2. **SSRF** — refuse a callback host in a private/link-local/metadata range, including via DNS rebinding
   at delivery time; refuse redirects; refuse to attach a credential to an unverified host; dev-mode
   allowlist fails closed in production.
3. **Concurrency** — two terminal transitions within a sub-millisecond window → exactly one wins, one
   `resolution_id`; a human answer at/before `expires_at` beats `default_on_expire`.
4. **State integrity** — a Response whose `state` was tampered is rejected by the agent (the seal key is
   per-agent, Hub-invisible; verify-before-use holds).
5. **Request-leg auth** (`dp-002`) — a message's poll/callback/cancel access is bound to the submitting
   principal: a second authenticated agent can neither read nor cancel another agent's message by id
   (`run_id` does not authorize cross-run access), and the non-submitter sees `404`, not `403`.
6. **Response-payload integrity** (`dp-003`) — the §9.2 signature binds `payload_sha256`, a digest of the
   response payload. A Response whose `response.value`/`comment`/`actor` or `state` is altered in transit —
   signed metadata and `MA2H-Signature` header left intact — fails verification, because the agent recomputes
   the digest from the payload it received (v0.3; issue #7).
7. **Numeric-payload canonicalization** (`dp-004`) — a `{ response, state }` carrying numbers (integer,
   negative, fraction, `1e-7`, `1e+21`, max-safe int 2^53-1, nested array/object) canonicalizes to the
   pinned RFC 8785 JCS bytes and `payload_sha256`. A non-JS signer whose number formatting diverges from
   ECMAScript `Number::toString` fails this, catching a cross-language digest mismatch before deployment
   (§9.2 / RFC 8785 §3.2.2.3; issue #10).
8. **Inbound directive signature** (`dp-005`) — the §9.7 directive signature: reproduce `v1` from
   JCS(`inbound_signed_context`) + HMAC-SHA256, and recompute `payload_sha256` from the `directive` (the
   mirror of `dp-001` for the human→agent leg; v0.4).
9. **Inbound tamper rejection** (`dp-006`) — the agent reconstructs the context from the directive it
   received; an altered `to` (cross-agent redirect), `from`, or `body` fails verification with a signature
   mismatch, so a directive signed for one agent cannot be replayed into another's mailbox (§9.7 / §13.5).
10. **Mailbox delivery semantics** (`dp-007`) — at-least-once + explicit consume/ack + `id` dedup +
    submitter-bound isolation + durability across restart (§8.7 / §13). Behavioural; proven against the
    Hub + its consuming agent (not executable from a JSON fixture — see the reference `inbound.test.ts`).
11. **Ack signature** (`dp-008`) — the §14.4 pushed-ack signature: reproduce `v1` from
    JCS(`ack_signed_context`) + HMAC-SHA256, and recompute `ack_sha256` from the `ack`. (Pulled acks are
    transport-trusted and unsigned; v0.4.)
12. **Ack tamper rejection** (`dp-009`) — the human's client recomputes `ack_sha256` from the received ack;
    an altered `note`/`by` fails verification with a signature mismatch (§14.4).
13. **Ack + presence behaviour** (`dp-010`) — ack terminal-once + submitter-bound + directive-consume-fold +
    the delivery track; presence derivation, states, and owner-only read (§14/§15). Behavioural; exercised
    by the reference `ack.test.ts` / `presence.test.ts`.

The **schema-validation** class also gains the inbound envelope: `sv-008` (valid directive), `sv-009`
(missing `to`), `sv-010` (a non-`human`/`system` `from`), `sv-011` (cross-type `request` rejected), `sv-012`
(a pre-0.4 `ma2h_version` rejected — directives are a v0.4 feature); and the cross-cutting primitives:
`sv-013` (valid ack), `sv-014` (pre-0.4 ack rejected), `sv-015` (valid presence), `sv-016` (bad presence
state rejected).
