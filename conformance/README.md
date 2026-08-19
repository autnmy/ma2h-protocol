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
[`examples/entry-signatures-v0.5.md`](../examples/entry-signatures-v0.5.md)) are pinned as the
deterministic fixtures `dp-011`..`dp-018`, and the v0.5 downstream proofs for sessions, routing, and
delivery honesty are stated in `dp-019`..`dp-024` (spec §12; the full clause-by-clause map is the
[v0.5 coverage map](#v05-coverage-map) below). The deterministic `dp-011`..`dp-018` fixtures carry
their expected runner wiring per-fixture and are **executed by the runner** (`npm run vectors`)
against the reference §9.8 signing/verifying code paths (issue #26): positives reproduce the pinned
canonical bytes + `v1` with the payload digest recomputed from the delivered entry; the
tamper/replay negatives reconstruct the destination binding from each case's **drain identity**,
never the wire. `dp-025` is likewise deterministic and runner-executed: its MAC well-formedness
accept/reject cases run against the reference's exported `isWellFormedMac`/`decodeMac` helpers —
THE wire rule for a `v1` value (§9.2/§9.7/§9.8; issue #41), with the well-formed case re-derived
from the reference signer as the drift control. The behavioural `dp-019`..`dp-024` obligations carry no deterministic fixture and
are reported as *skipped* with a pointer to the reference behavior suites that discharge them
(`reference/test/sessions.test.ts`, `interagent.test.ts`, `bridge.test.ts`) — a skip there means
"proven behaviourally, not fixture-replayable", never silently dropped.

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
14. **`message`-entry signature** (`dp-011`, `dp-012`) — the §9.8 inter-agent mirror of §9.7: reproduce
    `v1` from JCS(`message_signed_context`) + HMAC, recompute `payload_sha256` from the delivered
    entry's content fields (`type` and `sensitive` bound on this leg), and reject a tampered
    `from`/`to`/payload with a signature mismatch after the honest control verifies.
15. **`response`-entry signature** (`dp-013`, `dp-014`, `dp-015`) — §9.2's context with `to` (the
    delivery destination) in place of `callback_url` and the identical payload digest: the verifier
    reconstructs `to` from its **own** presented drain identity and `id` from the received
    `in_reply_to`, so an entry signed for one session fails verification replayed to any other —
    including another session of the *same* principal (`dp-014`). `dp-015` pins the §9.8
    reconstruction for a response-less task Response: `resolved_at` and the digest's `response`/`state`
    members serialize as JSON `null`, never dropped keys.
16. **`receipt`-entry signature** (`dp-016`, `dp-017`) — the §14.4 pattern applied to the bounce
    receipt: `receipt_sha256` over the fixed six-key wrapper (absent members as `null`, the ack-key
    `id` bound inside), `in_reply_to`/`to` bound top-level; a flipped `prior` (the seen-ness lie), a
    rebound `in_reply_to`, or a cross-destination replay fails verification.
17. **Per-delivery re-signing** (`dp-018`) — every delivery of a mailbox entry carries a fresh
    `t`/`jti` over the otherwise-identical context (two pinned deliveries, two distinct signatures);
    consumers reject an out-of-window `t` and a replayed `jti` (cache TTL ≥ window).
18. **Sessions** (`dp-019`) — lease CAS (close/expiry first-terminal-wins, immutable), renewal by
    client-originated activity only, the account-human kill-switch, registration bounds (`#`-id
    rejection, TTL clamps, live-session cap), unconditional own-session visibility, the advertised
    account-listing **ceiling** with per-account narrowing beneath it and the per-caller `scope` that
    narrowing makes necessary, and foreign-session indistinguishability (§16).
19. **Session-scoped drain + claim** (`dp-020`) — drain/ack/resolve session ownership (foreign/unknown
    → `404`, own-terminal → `410`), session-less drains isolated to the v0.4 shape (and the webhook
    directives-only), first-claim-wins for principal-addressed entries with crashed-claimant rescue,
    Hub-attested `from` carrying exactly the submitted session qualifier, the strip rule, the pinned
    per-kind ack keys, and human auditability (§8.7.1).
20. **Stream liveness + provisionality** (`dp-021`) — the zombie-socket rule (an open SSE socket is
    not liveness; bounded holds with a nonzero pre-expiry margin; reconnect is the renewal), the
    schema-inexpressible `stream_max_hold_seconds` ≤ `presence.freshness_seconds` cross-field, stream
    pushes advancing nothing without client-originated receipt evidence, and the §15 truthfulness
    split for addressed-message reachability (§8.7.2/§15).
21. **Delivery honesty** (`dp-022`, `dp-023`, `dp-024`) — bounce coverage on session death (drained-
    but-unacked included, `prior` preserving never-seen vs seen-then-orphaned, the principal-orphan
    terminal, `response`/`receipt` entries never bouncing), the `system:undeliverable`
    auto-resolutions on **both** undeliverable terminals, receipt dedup with no cascade, `expired` ⇒
    never delivered on both tracks (§14.2/§7); submit-time destination validation with the
    collapsed-`422` policy rules, the honest addressed ack (`queued`/`open` + the REQUIRED
    `destination` snapshot, including the schema-inexpressible addressed-`open` case), the sender-side
    misroute detector, and run-independent idempotent replay with the original session bound as Caller
    (§4/§8.1); the addressee resolver default with session-qualified matching, the §8.8 resolve
    binding, and the §13.4 v0.5 addressee duties (current-session check, explicit sender-authz policy)
    (§9.1/§13.4).
22. **MAC well-formedness** (`dp-025`) — the shared wire rule for a `v1` MAC value, exported by the
    reference as `isWellFormedMac`/`decodeMac` beside the signer that emits it (§9.2/§9.7/§9.8):
    base64url alphabet, RFC 4648 padding tolerated only when structurally valid (a 43-char value
    takes exactly one `=`, a 44-char value none), decoded length ≥ 32 bytes (floor, not exact) — and
    nothing more: no canonical round-trip, so a 43-char hex-shaped MAC is valid, while the
    standard-base64 alphabet (`+`/`/`) is a pinned reject. Deterministic accept/reject cases,
    executed by the runner against the reference helpers (issue #41; oh-hai#711).

The **schema-validation** class also gains the inbound envelope: `sv-008` (valid directive), `sv-009`
(missing `to`), `sv-010` (a non-`human`/`system` `from`), `sv-011` (cross-type `request` rejected), `sv-012`
(a pre-0.4 `ma2h_version` rejected — directives are a v0.4 feature); and the cross-cutting primitives:
`sv-013` (valid ack), `sv-014` (pre-0.4 ack rejected), `sv-015` (valid presence), `sv-016` (bad presence
state rejected).

## v0.5 coverage map

Every v0.5 obligation enumerated in spec §12's inter-agent paragraph, mapped to its coverage. Classes:
**sv** = schema-validation (executable), **dp** = downstream-proof (`dp-011`..`dp-018` and `dp-025`
deterministic — executed by the runner against the reference §9.8 code paths and the shared §9.2
MAC helpers, issues #26/#41;
`dp-019`..`dp-024` behavioural — discharged by the reference behavior suites and proven against a
conformant Hub), **pa** = prose-audit (`pa-002`, human sign-off). Numbers in
parentheses are the numbered sub-obligations inside a `dp` vector's `obligation` field.

| §12 clause (v0.5) | Coverage |
|-------------------|----------|
| `to` grammar — principal/session forms valid; `human:` rejected; first-`#` split; bad session segment | sv-017, sv-018, sv-019, sv-020 |
| `#`-bearing agent ids — inexpressible in `to`, rejected as addressed senders and session owners | sv-040, sv-044; dp-019 (2), dp-023 (5) |
| `agent.session` shape | sv-021 |
| Version-gated addressing (`to`/`agent.session`/entry kinds declare minor ≥ 5) | sv-038, sv-043, sv-049, sv-054 |
| Session resource, register/read shapes | sv-022, sv-044 |
| v0.5 capability objects (incl. dependency gates) | sv-023, sv-024, sv-051, sv-053, sv-054 |
| Submit-ack `queued` + `destination` (required for addressed statuses; exactly-unknown; terminal replays) | sv-025, sv-026, sv-033, sv-034, sv-036, sv-037, sv-048 |
| §8.8 resolve request (incl. both conditional branches) | sv-041, sv-042, sv-055, sv-056, sv-057 |
| The four delivered entry kinds (strip rule; per-kind ack keys; `res_` namespace; ≥ 0.5 gates; union regression) | sv-027..sv-032, sv-035, sv-045, sv-047 |
| §14.2 never-delivered conditionals on the GET body | sv-039, sv-050, sv-052 |
| `message`-entry signature: known input → known signature; digest recomputed; tampered `from`/`to`/payload rejected | dp-011, dp-012 |
| `response`-entry signature: `to`/`id` reconstruction; cross-session replay rejected; `resolved_at: null` pinning | dp-013, dp-014, dp-015 |
| `receipt`-entry signature: six-key wrapper; `prior`/`in_reply_to`/`to` tamper rejected | dp-016, dp-017 |
| Fresh `t`/`jti` per delivery; replayed `jti` rejected | dp-018 (with dp-011/dp-012 obligations) |
| `v1` MAC well-formedness (base64url alphabet; structural RFC 4648 padding; ≥ 32-byte floor; hex-shaped accept; `+`/`/` reject) | dp-025 |
| Session lease CAS (first terminal wins; renewal races; human kill-switch close) | dp-019 (4)–(7) |
| Operator kill-switch marker (`closed_by_operator: true` const/true-only; ⇒ state `closed`; `session_closed_by_operator` on own-session 410s — stop, not restart) | sv-058, sv-059, sv-060; dp-019 (7); pa-002 (§16) |
| Account-listing ceiling + per-caller `scope` (the advertised `agent_list_visibility` BOUNDS the grant and MAY be narrowed per account; the reported scope is the one APPLIED, never the ceiling; the field is optional and an omitted scope is unknown, never `account`) | sv-064, sv-065, sv-066; dp-019 (9) |
| First-claim-wins under concurrent session-presenting drains + crashed-claimant rescue | dp-020 (6), (7) |
| Stream-liveness truthfulness (zombie socket offline + lease lapse; reconnect-at-bound stays online) | dp-021 (1)–(3) |
| `stream_max_hold_seconds` ≤ `presence.freshness_seconds` (schema-inexpressible cross-field) | dp-021 (4); pa-002 (§8.0/§8.7.2) |
| Drain ownership (`?session=` foreign/unknown → `404`; own-terminal → `410`) | dp-020 (1), (2) |
| Stream-delivery provisionality (never-acked push reverts to queued; track never left `queued`) | dp-021 (5), (6) |
| Bounce-on-terminal for un-acked command entries (drained-but-unacked; `prior` distinction; principal-orphan; `response`/`receipt` never bounce) | dp-022 (1)–(4) |
| Explicit `mailbox.prior` on the `bounced` terminal (stamped once at the bounce transition; equals the receipt's `prior`; `prior: "queued"` ⇒ no `delivered_at`; never on a non-bounced state) | sv-061, sv-062, sv-063; dp-022 (2) |
| Ask auto-`cancelled` / task auto-`dismissed` as `system:undeliverable` on **both** undeliverable terminals | dp-022 (5) |
| Receipts deduped on `(in_reply_to, event)`, best-effort, never cascading | dp-022 (6) |
| Delivery-track truthfulness (`expired` ⇒ never delivered on both tracks; no `online` without qualifying activity) | dp-022 (7)–(9); dp-021 (6), (7) |
| Addressed-ack honesty (notify `queued`, ask/task `open`; **every** addressed ack — `open` included — carries `destination`) | dp-023 (7), (8) |
| Submit-time destination validation (unknown/terminal/cross-account; allowlist-block collapse; policy-tied `{"state": "unknown"}`) | dp-023 (1)–(4), (6) |
| Misroute detector (addressed ack sans `destination` → sender surfaces failure, cancels ask) | dp-023 (9) |
| Idempotent replay from a new session/run → original ack, original session bound as Caller | dp-023 (10) |
| Addressee-only resolver default (submitter's resolve rejected; account human rejected absent listing) | dp-024 (1), (2) |
| Session-qualified `allowed_resolvers` matching (entry grammar + behaviour) | sv-046; dp-024 (3), (4) |
| Session-qualified addressee check on the recipient (§13.4, incl. explicit sender-authz policy) | dp-024 (6)–(8) |
| Attested `from` carries exactly the submitted `agent.session` qualifier (cross-field equality) | dp-020 (8) |
| 0.4 session-less drain isolation (never receives the v0.5 entry kinds; webhook directives-only) | dp-020 (3), (4) |
| v0.5 durability (un-acked entries of any kind; active leases; pending bounce obligations survive restart) | pa-002 (§3.1) |
| Normative v0.5 spec text present and correctly scoped (grammar, opt-in gates, §9.8 discipline, §10 additivity, §13.4/§13.5 duties, §14.2 terminals, §15/§16 rules) | pa-002 (24 asserts) |
