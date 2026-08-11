# Worked example — the v0.5 inter-agent entry signatures (§9.8)

This shows how a Hub signs the three **v0.5 mailbox entry kinds** — `message`, `response`, and
`receipt` (spec §8.7) — resolving SCP #24's Unresolved Question 1 with pinned signed-context field
lists. All three follow the house pattern (§9.2/§9.7): RFC 8785 JCS canonicalization, a detached
signature over a canonical context, digests over a **fixed-key wrapper** recomputed by the verifier,
and **per-delivery re-signing with a fresh `t`/`jti`** (an entry may rest in a mailbox arbitrarily
long; only `t`/`jti` change per delivery).

All values below use the test key `ma2h-test-secret-key-0123456789ab` (HMAC-SHA256) and are
deterministic. The corresponding `dp-*` conformance fixtures land with the vectors issue (#27); until
then, reproduce these values with any conformant JCS implementation (e.g. the reference
`canonicalize.ts`).

One story throughout: coordinator `overseer/fleet` (session `sess_01J5OVR0001`) asks worker
`deploybot/dev-team` (session `sess_01J5WRK0007`) for permission to restart its queue consumer; the
worker answers; later, a second message bounces when the worker's session dies.

## 1. The `message` entry — the §9.7 mirror

The delivered entry is [`message-inter-agent-ask.json`](message-inter-agent-ask.json): the submitted
§4 ask plus Hub-assigned `id` and Hub-attested session-qualified `from` (`state`, `client_ref`, and
any `request.callback` stripped, spec §8.7).

### 1a. `payload_sha256` — SHA-256 of JCS(`{ "message": <content> }`)

The content object carries exactly the delivered envelope's **present** fields among `type`, `title`,
`body`, `priority`, `tags`, `context`, `request`, `action`, `sensitive` (here: `type`, `title`,
`request`).
Transport/Hub metadata (`id`, `from`, `to`, `created_at`, `expires_at`) is excluded — `from`/`id`/`to`
are bound as top-level signed fields instead — and the advisory `agent` descriptor and inert
`idempotency_key` are excluded exactly as §9.2 leaves the Response's top-level `agent` unbound:

```
{"message":{"request":{"allowed_resolvers":["agent:deploybot/dev-team"],"mode":"confirm"},"title":"May I restart your queue consumer?","type":"ask"}}

payload_sha256 = f5d7fe8d3c10f59cf353375d9dd078bf36c74cb7cf503ed76fcdb2de3ad719ee
```

### 1b. The canonical `message_signed_context` (RFC 8785 JCS)

```
{"from":"agent:overseer/fleet#sess_01J5OVR0001","id":"msg_01J5MSG0002","jti":"jti_01J5MSGDEMOFIX","ma2h_version":"0.5","payload_sha256":"f5d7fe8d3c10f59cf353375d9dd078bf36c74cb7cf503ed76fcdb2de3ad719ee","t":"1786752000","to":"agent:deploybot/dev-team#sess_01J5WRK0007"}
```

### 1c. The wire header

```
MA2H-Signature: t=1786752000,jti=jti_01J5MSGDEMOFIX,v1=4ppFPmg1vtR0F4Fu0LWHWxKXCXyM-CUdMgkFF_xswPA
```

The recipient verifies exactly as for a directive (§13.4, applied wholesale): validate shape against
`inbound-message.schema.json` (rejecting an unsigned injected `state`/`client_ref`/`callback`),
recompute `payload_sha256` from the entry it received, rebuild the context, verify, **confirm the
addressee** (`to`'s principal is itself AND the session qualifier names its own *current* session),
check its deployment-declared sender policy for an `ask`/`task`, dedup on `id`, act at most once, ack.

## 2. The `response` entry — §9.2 with `to` in place of `callback_url`

The worker resolves the ask; the Hub delivers the §6 Response to the **submitting** session's mailbox
as a `response` entry. The Response body is byte-for-byte the v0.4 shape — the destination is bound
only in the signed context.

### 2a. `payload_sha256` — identical to §9.2

SHA-256 of JCS(`{ "response": <response|null>, "state": <state|null> }`) — the same digest a §9.2
callback verifier computes, shared code path:

```
{"response":{"actor":"agent:deploybot/dev-team#sess_01J5WRK0007","edited":false,"resolved_at":"2026-08-10T12:05:00Z","value":"approve"},"state":{"sealed":"v1.demo.MOCK-SEALED-STATE-BLOB"}}

payload_sha256 = 21bf7d8c7b9245170bbe80d0256de0779fa2490a08cc96c3c4e02568a33f997f
```

### 2b. The canonical `response_signed_context`

§9.2's key set with `callback_url` replaced by `to` — the session-qualified address of the submitting
session this entry is delivered to. The verifier **reconstructs** `to` from its own presented drain
identity (its `agent.id` + the session it presented), exactly as a §9.2 verifier reconstructs
`callback_url` from its own endpoint; a response entry signed for one session fails verification
replayed to any other. `id` is reconstructed from the delivered `in_reply_to` — the two are always
equal (both name the original message record, spec §9.8):

```
{"id":"msg_01J5MSG0002","in_reply_to":"msg_01J5MSG0002","jti":"jti_01J5RSPDEMOFIX","ma2h_version":"0.5","payload_sha256":"21bf7d8c7b9245170bbe80d0256de0779fa2490a08cc96c3c4e02568a33f997f","resolution":"answered","resolution_id":"res_01J5RSLV0001","resolved_at":"2026-08-10T12:05:00Z","t":"1786752060","to":"agent:overseer/fleet#sess_01J5OVR0001"}
```

### 2c. The wire header

```
MA2H-Signature: t=1786752060,jti=jti_01J5RSPDEMOFIX,v1=ML7nxivSFOMqQ8CerEeBJmMV6919d9GZ5GbSd49n36c
```

The submitter dedups on `(in_reply_to, resolution_id)` — the same Response may also arrive via §8.2
pull or a §8.3 callback (each channel carries the same `resolution_id`), and `state` stays untrusted
until the agent verifies the integrity it applied (§9.3). One reconstruction rule to note: when a task
Response legitimately carries **no** `response` detail at all, this context's `resolved_at` is JSON
`null` (spec §9.8) — here the detail is present, so its `resolved_at` binds.

## 3. The `receipt` entry — the §14.4 ack pattern

Later, an addressed notify (`msg_01J5MSG0003`) is still queued when the worker's session
`sess_01J5WRK0007` goes terminal: the entry bounces (§14.2) and the Hub notifies the sender's live
session with [`receipt-bounced.json`](receipt-bounced.json).

### 3a. `receipt_sha256` — SHA-256 of the fixed-key wrapper

Exactly six keys — `{ at, event, id, in_reply_to, prior, session }` — with any absent member
serialized as JSON `null` (all six are present in a v0.5 bounce receipt; the `null` convention matches
§14.4's `ack_sha256` wrapper). The receipt's `id` is its §8.7.1 **ack key**, so binding it here means
the key a consumer acks is authenticated:

```
{"at":"2026-08-10T12:20:00Z","event":"bounced","id":"rcpt_01J5RCPT0001","in_reply_to":"msg_01J5MSG0003","prior":"queued","session":"sess_01J5WRK0007"}

receipt_sha256 = 40abdcfbc1b8c32ed106288063609e5ef7a295f578afa1b17cde5d1c7405bcd6
```

`prior: "queued"` tells the sender the message was **never seen** (a `"delivered"` would mean
drained-but-unacked when the session died — seen-then-orphaned, §14.2).

### 3b. The canonical `receipt_signed_context`

```
{"in_reply_to":"msg_01J5MSG0003","jti":"jti_01J5RCPDEMOFIX","ma2h_version":"0.5","receipt_sha256":"40abdcfbc1b8c32ed106288063609e5ef7a295f578afa1b17cde5d1c7405bcd6","t":"1786752120","to":"agent:overseer/fleet#sess_01J5OVR0001"}
```

### 3c. The wire header

```
MA2H-Signature: t=1786752120,jti=jti_01J5RCPDEMOFIX,v1=-80T4jjtirjLy6Fri6osKG_gPS-CQhfd9uXgV0_9l78
```

The sender verifies, dedups on `(in_reply_to, event)`, acks by the receipt's `id` (its ack key —
distinct from the `res_` key of the auto-cancellation `response` entry that can sit beside it for the
same `in_reply_to`), and treats its §8.2 pull as authoritative —
receipts are best-effort and MUST NOT generate receipts. Verification is still a MUST: an unverified
receipt could fabricate a bounce and trick a sender into abandoning a live ask. (The bounce also
auto-resolved nothing here — a `notify` has no resolution track; had `msg_01J5MSG0003` been an ask, it
would now read `cancelled` by `system:undeliverable`, §7.)
