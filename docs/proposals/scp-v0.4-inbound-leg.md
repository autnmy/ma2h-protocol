# SCP: MA2H v0.4 — human→agent directive (the inbound leg)

## Preamble
- **Author(s):** Autonomy (dev-team)
- **Status:** Draft
- **Type:** Standards Track (normative)
- **Created:** 2026-06-30
- **Tracking issue:** [#18](https://github.com/autnmy/ma2h-protocol/issues/18)
- **SCP issue:** [#19](https://github.com/autnmy/ma2h-protocol/issues/19)
- **Linked PR:** _(added when the implementation PR opens)_
- **Version bump:** **MINOR (0.3 → 0.4)** — additive, non-breaking. No schema `$id` retightening; a new
  `schema/v0.4/` version path is minted as a full snapshot (repo convention), the agent→human schemas
  unchanged in shape.

## Abstract

MA2H is one-directional today: agents reach humans (`notify`/`ask`/`task`) and receive decisions back. This
SCP adds the mirror leg — a **human sends a message to a specific agent** — reusing the machinery of the
v0.3 return leg rather than inventing new mechanisms. A Hub-attested `human:<id>` authors a **directive**
addressed to `agent:<id>`; the agent drains a **durable per-agent mailbox** via an authenticated poll
(pull-first), or receives a signed webhook push if it has advertised one. Delivery is **at-least-once with
`jti`/`id` dedup and explicit consume/ack**, FIFO per agent. Each delivery carries a §9.2-symmetric detached
Hub signature (new §9.7) the agent verifies. It is **additive and backward-compatible**: every v0.3 leg is
untouched and a 0.4 Hub still accepts 0.3 agent→human envelopes.

## Motivation

The defining MA2H asymmetry: an agent can hand a decision to a human, but a human cannot hand an instruction
to a running (or ephemeral, re-invokable) agent through the same neutral channel. Operators improvise
side-channels — a git commit a bot scrapes, a Slack DM, a bespoke queue — none authenticated, ordered, or
durable, and none reusing the trust model MA2H already ships. The inbound leg closes the loop: the same Hub
that fans agent messages in to one human can fan one human's directives back out to a specific agent, with
the same server-authoritative trust (Hub-attested author, detached signature the agent verifies, durable
at-least-once delivery). Without it, every product built on MA2H reinvents an unsafe inbound path.

## Specification

Full normative text lands in [`spec/v0.4.md`](../../spec/v0.4.md) §8.7 (transport), §9.7 (signature), and
§13 (the leg). Summary:

### The directive envelope (`schema/v0.4/inbound-message.schema.json`, §13.1)
The **delivered** form; `id`/`from` are Hub-assigned/attested:
- `ma2h_version` `"0.4"`, `type` `"directive"`, `id` (Hub-assigned), `created_at`.
- **`from`** — Hub-attested author, `^(human|system):.+$` (derived from the operator session, never the
  request body — exactly as §9.1 attests `actor`). `human:<id>` in v0.4.
- **`to`** — `^agent:.+$`, the addressed agent (the mailbox key).
- `title` (MUST), `body`/`priority`/`tags`/`context` (reuse §4 / the `Part` union), `expires_at`,
  `sensitive` (MAY).
- No `request`/`action`/`state` (schema-enforced): inbound ask/task deferred; a directive is not a resume
  blob.

### Transport (§8.7)
- **Drain (pull):** `GET /v1/inbox` — bearer-authenticated; the credential's `agent.id` selects the
  mailbox. Returns up to `?max=N` oldest un-acked directives in FIFO order, each with its `MA2H-Signature`;
  `?wait=<seconds>` long-polls (mirror §8.2). Returned directives go in-flight for a visibility window.
- **Consume (ack):** `POST /v1/inbox/ack` `{ "ids": [...] }` — removes acked directives; idempotent;
  submitter-bound. Un-acked directives are redelivered after the window (at-least-once); the agent dedups
  on `id` and acts at most once.
- **Webhook (push, optional):** to a pre-registered, §9.4-verified inbound callback, following the §8.3
  at-least-once retry rules. Pull remains the source of truth and fallback.

### Authenticity (§9.7 — §9.2-symmetric)
The Hub signs **each delivery** (re-signed with a current `t` + fresh `jti`, so a directive resting in the
mailbox for hours still lands inside the agent's replay window). Detached signature over JCS of:
```
inbound_signed_context = { from, id, jti, ma2h_version, payload_sha256, t, to }
```
`payload_sha256` = lowercase-hex SHA-256 of JCS(`{ "directive": <the present title/body/priority/tags/context> }`).
Binding `to` prevents cross-agent replay; binding `id` is the stable at-most-once key; binding `from`
authenticates the author. The agent recomputes `payload_sha256` from the received directive, verifies,
rejects a `t` outside the window and a replayed `jti`. Header reuses `MA2H-Signature`.

### Discovery (§8.0)
`capability` gains an optional `inbound` object: `{ enabled, poll_url, ack_url, max_batch,
visibility_timeout_seconds, retention_days, signature_algs, webhook_supported }`. A v0.3-only Hub omits it.

## Rationale & alternatives

| Decision | Choice | Why |
|---|---|---|
| Message `type` | **`directive`** | Distinct from the agent→human `notify` (no direction-dependent disambiguation of an easy-to-confuse field); connotes "a human directing an agent" while covering the FYI case. Alternatives `notify` (collides), `message` (too generic) rejected. |
| Endpoint path(s) | **`GET /v1/inbox` + `POST /v1/inbox/ack`** | Mirrors the `/v1/messages` outbound style; "inbox" reads from the agent's side. |
| Capability field | **`inbound` (nested object)** | Groups the mailbox knobs; keeps the flat top-level fields uncluttered (as `rate_limit` already does). |
| Consume/ack | **Peek + explicit per-`id` ack with a visibility timeout** (SQS-style) | The clean at-least-once shape: nothing lost on a mid-process crash; redelivery automatic; `id` dedup gives at-most-once *within the agent's dedup horizon* (cross-restart at-most-once needs an idempotent action or persisted dedup state — §13.4). Cursor-ack rejected — head-of-line blocking, no partial ack. |
| Per-agent ordering | **FIFO on first delivery; best-effort under redelivery** | Strict total order is incompatible with at-least-once + individual acks; the agent dedups on `id` and MUST NOT depend on strict order for correctness. |
| Retention / expiry | **Un-acked retained for a Hub TTL (default 30d, advertised); `expires_at`/TTL bounds deliverability; on expiry the Hub drops it — no response leg** | Directives are the `notify` mirror: fire-and-forget, terminal on ack/expiry. |
| Signature on pull | **MUST verify on both channels** | Directives are *unsolicited inbound commands* that drive agent behavior (a prompt-/command-injection surface), so origin authentication matters more than for a solicited pull response; uniform MUST-verify is simpler and gives one conformance path. Intentionally stronger than the §8.2 "authenticated GET is trusted transport" stance for the return leg. |
| Human→agent **ask/task** | **Defer** | Keeps v0.4 minimal; a routed agent-response leg (mirror of §6) needs agent-side resolution, an attested `agent:` actor on the return leg, and a second signed leg — its own SCP. |

## Backward compatibility

MINOR, non-breaking. New `spec/v0.4.md` + `schema/v0.4/` (full snapshot; agent→human schemas re-`$id`'d to
the v0.4 path, unchanged shape; `capability` extended; `inbound-message.schema.json` added). The
`ma2h_version` pattern stays `^0\.\d+$`. A 0.4 Hub accepts 0.3 agent→human envelopes and signs their
Responses at the version carried (the §9.2 algorithm is unchanged). One reference fix the bump forces: the
pre-0.3-push parity threshold is pinned to the **signature-break minor (3)**, not "implemented minor," so a
0.4 Hub still accepts a 0.3 push (0.3 and 0.4 share the payload-bound signature) and still rejects a pre-0.3
push. The directive signature (§9.7) is a *new* context, so it interoperates only 0.4-Hub ↔ 0.4-aware-agent
— but a pre-0.4 agent simply does not consume the inbound leg, so nothing it already does breaks. Historical
`spec/v0.3.md` + `schema/v0.3/` remain on disk.

## Security considerations

Per RFC 3552, this leg **opens** an attack surface and the design closes it:
- **Authenticity / prompt-injection.** A directive enters the agent's execution/LLM context, so a forged or
  tampered directive is a command-injection vector. Mitigations: Hub-attested `from`, the §9.7 detached
  signature the agent MUST verify, `payload_sha256` binding the instruction bytes, `to`-binding plus the
  agent's own **addressee check** (`to == self`, §13.4) against cross-agent replay, and a `jti` cache +
  window against signature replay. `created_at`/`expires_at`/`sensitive` are unbound Hub-authoritative
  advisory metadata and MUST NOT drive agent security decisions. Verification proves origin, not
  intent-safety — an agent SHOULD additionally authorize *which* `from` principals may instruct it, and to
  do what.
- **Authorization / isolation.** Bearer scoped to `agent.id` selects the mailbox; a principal cannot drain
  or ack another agent's mailbox, and a foreign/unknown id is indistinguishable from a non-existent one
  (mirror §9.1 submitter-binding).
- **SSRF.** The optional webhook reuses §9.4 wholesale (host-ownership verification, delivery-time
  private-range refusal / DNS-rebinding defense, no redirects, credential-host binding).
- **Content safety.** The agent MUST treat `body`/`context` as untrusted (the inbound mirror of §9.6); a
  Hub echoing a directive into HTML applies §9.6 sanitization.
- **Durability.** Un-acked directives and pending webhook obligations survive Hub restart (§3.1 extended).

## Conformance

- **Schema-validation:** `sv-008` (valid directive), `sv-009` (missing `to`), `sv-010` (non-`human`/`system`
  `from`), `sv-011` (cross-type `request` rejected).
- **Downstream-proof:** `dp-005` (deterministic §9.7 signature fixture + recompute), `dp-006` (tamper /
  cross-agent-replay rejection), `dp-007` (mailbox at-least-once + consume/ack + `id` dedup + isolation +
  durability obligation).
- **Prose-audit:** `pa-001` gains the inbound MUSTs (envelope attestation, inbox auth/isolation, delivery
  semantics, §9.7 signing, additive/back-compat, durability).

## Reference implementation

In `reference/`: Hub mailbox (`sendDirective` / `drainInbox` / `ackInbox`, per-delivery signing, visibility
timeout, expiry), agent `receiveDirective` (verify + `id` dedup), inbound signing/verify + directive-payload
digest, new schema + validator, `test/inbound.test.ts`, an inbound segment in the demo, and the vector-runner
branches for `dp-005`/`dp-006`. `npm test` is green (67/67); the deterministic fixtures are pinned in
`dp-005`.

## Unresolved questions

- Batch-ack vs cursor-ack ergonomics (recommend per-`id` batch ack; open to a cursor form if review
  prefers).
- Whether `system:`-authored directives (Hub-originated) ship in v0.4 or wait for a driver (leaning: allow
  the `from` pattern now, populate `human:` in v0.4).
- Agent inbound-webhook **registration** is left implementation-defined (same host-ownership verification as
  §9.4); a future SCP could standardize a registration handshake.

## Future possibilities

The deferred human→agent **ask/task** — a routed agent-response leg (the mirror of §6, with an attested
`agent:` actor and a second signed leg) — is the natural next step this leg sets up. Multi-turn threaded
directives and channel fan-out (Slack/email origination of a directive) also compose cleanly on top.
