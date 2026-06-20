# AHCP Conformance Vectors (v0.3)

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
  -s schema/v0.3/<target> \
  -r "schema/v0.3/*.schema.json" \
  -d <input.json>
```

or load all five schemas into any Draft 2020-12 validator and check each vector's `input` against its
`target`, asserting the declared `expect`.

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
   signed metadata and `AHCP-Signature` header left intact — fails verification, because the agent recomputes
   the digest from the payload it received (v0.3; issue #7).
7. **Numeric-payload canonicalization** (`dp-004`) — a `{ response, state }` carrying numbers (integer,
   negative, fraction, `1e-7`, `1e+21`, max-safe int 2^53-1, nested array/object) canonicalizes to the
   pinned RFC 8785 JCS bytes and `payload_sha256`. A non-JS signer whose number formatting diverges from
   ECMAScript `Number::toString` fails this, catching a cross-language digest mismatch before deployment
   (§9.2 / RFC 8785 §3.2.2.3; issue #10).
