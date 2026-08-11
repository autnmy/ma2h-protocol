# Changelog

All notable changes to the MA2H (Multi-agent to Human Protocol) specification.

## Unreleased

### Added (v0.5 — the inter-agent leg: sessions, addressed envelopes, delivery honesty, §16/§8.7/§9.8) — SCP #24
**Additive and backward-compatible (MINOR).** v0.5 adds hub-mediated, store-and-forward messaging
between agents of the same account, plus the **session** primitive that makes it addressable and
honest. Every v0.3/v0.4 wire format is byte-for-byte unchanged; the leg is **account-opt-in**
(`inter_agent.enabled` defaults false). Designed via SCP #24 (r2, six-persona review-hardened;
archived at [docs/proposals/scp-v0.5-inter-agent-leg.md](docs/proposals/scp-v0.5-inter-agent-leg.md)).
See [MIGRATION.md](MIGRATION.md#v04--v05-the-inter-agent-leg).

- **Sessions (§16)** — a Hub-registered, lease-bound, ephemeral *address* under an existing `agent.id`
  (`POST /v1/sessions`, Hub-minted `^sess_` ids; no new credentials). Lease renewal is strictly
  **client-originated** (a merely-open socket is never evidence); states `active → closed | expired`,
  first-terminal-wins; terminal touchpoints pinned (submit `410`/`422`; drain `410` vs `404`);
  owner-only operations plus the account-human **kill-switch**; unconditional own-session visibility;
  policy-gated fleet listing (`sessions.agent_list_visibility`); discovery rides the attested `from`.
- **Addressed envelopes (§4)** — optional `to: agent:<id>` / `agent:<id>#<session>` routes any verb to
  the destination's §8.7 mailbox (first-`#`-splits grammar; `to: human:` invalid). Submit-time
  destination validation (retroactively REQUIRED for the §13 directive `to`): `422
  unknown_destination` / `410 destination_gone` (§8.5) — no silent dead-letter, no existence oracle.
  An addressed `notify` is accepted **`queued`, never `delivered`** (its lifecycle IS the delivery
  track); an addressed `ask`/`task` stays `open` (its `status` is the §7 resolution track, replay-
  unambiguous). Every addressed ack REQUIRES the `destination` reachability snapshot — the addressed
  marker — and an addressed ack **without** it is the pre-0.5 **misroute detector** a 0.5 sender MUST
  surface (§8.1). `agent.session` binds the Caller's mailbox;
  `agent.session`/`agent.run_id` are excluded from the §8.1 idempotency comparison (first submit's
  session stays the bound Caller).
- **Three mailbox entry kinds (§8.7)** — delivered only to session-presenting drains
  (`GET /v1/inbox?session=`; a session-less drain returns exactly the v0.4 shape): **`message`** (the
  addressed §4 envelope, Hub-attested session-qualified `from`, submitter machinery stripped),
  **`response`** (the §6 Response to the submitting session — the attested `agent:` return leg §2 was
  missing; webhook-free push-grade latency), **`receipt`** (Hub-originated delivery-status
  notification, v0.5: the bounce, with `prior` preserving never-seen vs seen-then-orphaned).
  Session-addressed entries are session-only; principal-addressed entries are **first-claim-wins**
  role delivery (racing sessions = the documented degraded mode). Addressed messages default out of
  the human triage inbox but stay human-auditable. Optional **SSE stream** (`inbound.stream_url`) with
  the **zombie-socket rule**: bounded holds (`stream_max_hold_seconds` ≤ freshness window),
  reconnect-as-renewal, and **provisional** stream delivery (the track advances only on
  client-originated evidence). Long-poll remains the conformance floor.
- **Delivery honesty (§14.2, §7)** — the mailbox track gains terminals **`bounced`** (covers every
  un-acked session-addressed entry on session death, *including drained-but-unacked*) and
  **`expired`** (MUST mean *never delivered* — the anti-false-belief invariant); a bounced ask
  auto-resolves `cancelled` / task `dismissed` as attested `system:undeliverable` (first-terminal-wins
  no-op if already resolved); the ask/task **response track** gains terminal `expired` (an answer
  never picked up now terminates visibly). Sender's §8.2 pull is authoritative; receipts are
  best-effort, deduped `(in_reply_to, event)`, never cascading.
- **Reachability (§15)** — per-session presence from client-originated activity; derivation **split
  per consumption capability** (session-bearing for addressed-message reachability vs unchanged
  any-drain directive presence — no v0.4 regression); the **truthfulness rule**: no `online` absent
  qualifying activity, no track advance absent client-originated receipt evidence. `GET /v1/sessions`
  joins the §15.3 read surface, same visibility policy as the §8.1 snapshot (no oracles).
- **Resolution by agents (§6, §9.1)** — the addressee resolves an addressed `ask`/`task` as the
  attested session-qualified `agent:` actor; `allowed_resolvers` **default flips to the addressee**
  (the submitter must not answer its own ask; the account human is deliberately NOT a default resolver
  — the kill-switch is the recourse). §7 CAS, modes, expiry, cancel: unchanged.
- **Entry signatures (§9.8; SCP UQ1 resolved)** — three pinned contexts on the §9.2/§9.7 pattern, JCS
  + fixed-key digests + per-delivery fresh `t`/`jti`: `message` mirrors §9.7
  (`{from,id,jti,ma2h_version,payload_sha256,t,to}`, payload over `{message: <present content
  fields incl. type/request/action>}`); `response` is §9.2 with `callback_url` → `to` (identical
  payload digest; `to` reconstructed from the drain identity); `receipt` follows §14.4
  (`receipt_sha256` over fixed-key `{at,event,id,in_reply_to,prior,session}` — the receipt's `id` is
  its ack key, bound so the key a consumer acks is authenticated). Worked deterministic
  examples: [examples/entry-signatures-v0.5.md](examples/entry-signatures-v0.5.md).
- **Security posture** — trust boundary unchanged (the account; cross-account rejected as unknown).
  Lateral movement is the named threat center, closed in layers: account opt-in + REQUIRED Hub
  support for per-destination sender allowlists + a MANDATORY deployment-declared recipient policy
  before acting on an addressed `ask`/`task` (§13.4) + human auditability. Same-principal session
  impersonation documented as the known limitation (per-session tokens: roadmap).
- **Discovery (§8.0)** — `sessions` + `inter_agent` capability objects; `inbound` gains
  `session_param`/`stream_url`/`stream_max_hold_seconds`; `inter_agent` REQUIRES the §14 ack
  primitive incl. the v0.5 terminals.
- **Schemas** — `schema/v0.5/` full snapshot (no existing `$id` changes): `message` gains
  `to`/`agent.session`; closed `submit-ack` lists `queued` + `destination`; `get-message` carries the
  v0.5 delivery states; `capability` gains the v0.5 objects; `inbound-message` becomes the four-kind
  delivered-entry union; `response` types the task checklist and pins the `res_` ack-key namespace (§8.7.1's disjoint id namespaces are schema-enforced); new `session.schema.json` + `resolve-request.schema.json`.
- **Resolve binding (§8.8)** — `POST /v1/messages/{id}/resolve` pinned on the wire
  (`resolve-request.schema.json`): the §14.3-named sub-action v0.4 kept product-internal becomes
  interoperable, because the inter-agent addressee resolves over the wire — body
  (`resolution`/`value`/`comment`/`checklist`), `?session=` presentation for session-qualified
  actors/resolver entries, §7 CAS semantics (`409 already_terminal` on a lost race).
- **Conformance** — `sv-017..043` (grammar incl. sender-side `#` symmetry and version-gated
  addressing, session shapes, capability, submit-ack conditionals, resolve request, entry kinds incl.
  the strip rule + per-kind ack keys + ≥ 0.5 gates, §14.2 never-delivered conditionals, union
  regression); the reference harness routes `v0.5/`-prefixed vector targets to a
  second ajv registry (v0.4 suite untouched, 110/110). §12 enumerates the v0.5 signature +
  downstream-proof obligations, which land with the reference implementation (#26) and vectors (#27)
  issues per the conformance gate.

### Added (v0.4 — cross-cutting acknowledgment + presence primitives, §14/§15) — SCP #21
Two primitives that enrich **both** directions (the shipped v0.3 response leg *and* the new inbound leg),
modeled once and applied to each — additive, non-breaking, capability-advertised:
- **Acknowledgment / receipt** (§14) — a terminal receipt the receiving party posts (agent: *"got it, on
  it"* / *"got your Ship it — resuming"*). One shared `ack` envelope (`schema/v0.4/ack.schema.json`) +
  `acknowledged` status; resource-scoped transport (response leg `POST /v1/messages/{id}/ack`; directive
  receipt folds into `POST /v1/inbox/ack` via an optional `note`). Additive **delivery** track orthogonal to
  the §7 `resolution` (directive `queued→delivered→acknowledged`; ask/task
  `answered→delivered-to-agent→acknowledged`), surfaced on the GET body. Trust = §6 response-leg parity:
  pull transport-trusted; a **pushed** ack is signed per §14.4 (`ack_signed_context`; `dp-008`/`dp-009`).
- **Presence / "listening"** (§15) — a derived per-agent `last_seen` from existing poll/long-poll/SSE
  activity (no heartbeat, no always-on socket); `online`/`offline`/`unknown` by an advertised window; read
  at `GET /v1/agents/{id}/presence` (`presence.schema.json`), owner-only per-account.
- `capability` gains `ack` + `presence` (§8.0); reference Hub (`ackMessage`/`ackInbox` note/delivery track,
  presence derivation, `signAckForPush`), `ack.test.ts`/`presence.test.ts`, vectors `sv-013..016` +
  `dp-008/009/010`. Stacked on the inbound-leg PR (#20) and held in one v0.4 merge train.

### Added (v0.4 — the human→agent inbound leg, §13)
**Additive and backward-compatible.** v0.4 introduces the **directive**: a Hub-attested `human:<id>` sends an
instruction/FYI addressed to one `agent:<id>`, and the agent drains it from a **durable per-agent mailbox**
using the same pull-first / webhook-optional mechanism the v0.3 response leg already uses. **No v0.3 wire
format changes** — every v0.3 leg (notify/ask/task + responses) is byte-for-byte unchanged, and a 0.4 Hub
stays backward-compatible with 0.3 agent→human envelopes. See
[MIGRATION.md](MIGRATION.md#v03--v04-the-inbound-leg).

- **`directive` message type** (§13.1) + `schema/v0.4/inbound-message.schema.json` — a Hub-attested `from`
  (`^(human|system):.+$`) addressed `to` an `agent:<id>`; no `request`/`action`/`state` (inbound ask/task
  deferred; a directive is the one-way `notify` mirror).
- **Mailbox transport** (§8.7) — `GET /v1/inbox` (drain, FIFO, long-poll-capable) + `POST /v1/inbox/ack`
  (consume), authenticated by the agent's existing bearer credential scoped to `agent.id`. Delivery is
  **at-least-once** with visibility-timeout redelivery, explicit consume/ack, and `id` dedup; an optional
  webhook reuses the §8.3 retry rules and §9.4 SSRF controls, with the mailbox as the source of truth.
- **Directive signature** (§9.7) — the §9.2-symmetric detached signature over
  `inbound_signed_context = { from, id, jti, ma2h_version, payload_sha256, t, to }`, RE-SIGNED per delivery
  with a fresh `t`/`jti` (so an old mailbox directive stays in-window). `payload_sha256` binds the
  instruction content; `to` binds against cross-agent replay; the agent MUST verify on **both** channels.
- **Discovery** (§8.0) — the `capability` document gains an optional `inbound` object; a v0.3-only Hub
  omits it.
- **Durability** (§3.1) — un-acked directives and pending directive-webhook obligations survive Hub restart.
- **Conformance** — `sv-008..011` (directive envelope: valid / missing `to` / bad `from` / cross-type), the
  `dp-005` deterministic directive-signature fixture, `dp-006` tamper/cross-agent-replay rejection, and the
  `dp-007` mailbox-semantics obligation; `pa-001` gains the inbound MUSTs.
- **Reference** — Hub mailbox (`sendDirective`/`drainInbox`/`ackInbox`), agent `receiveDirective`
  (verify + dedup), inbound signing/verify, new schema + validator, `inbound.test.ts`, and an inbound-leg
  segment in the demo. `spec/v0.4.md` + `schema/v0.4/` are a full snapshot (the agent→human schemas
  re-`$id`'d to the v0.4 path, unchanged shape; `capability` extended; `inbound-message.schema.json` added);
  historical `spec/v0.3.md` + `schema/v0.3/` remain the v0.3 snapshot.
- **`ma2h-skills` plugin (v0.2.0)** — new **`build-inbox`** skill scaffolds an app-specific agent-side
  mailbox-drain skill (verify §9.7 signature, validate shape, addressee check, dedup, ack) for the inbound
  leg; **`implement`** gains an optional §6 covering the inbox transport, directive signing, and mailbox
  MUSTs; the `build-notify`/`build-ask`/`build-task` sender templates and all skill spec/schema links move
  to v0.4. README, plugin/marketplace manifests, `reference/README`, the `ma2h verbs` CLI, and the
  `ma2h.org` site (`index.html`) updated for the inbound leg.

### Changed
- **Push-parity threshold anchored at the signature-break minor (3), not "implemented minor" (v0.4).** The
  reference Hub still rejects a **pre-0.3** push, but now continues to accept a **0.3** push against a 0.4
  Hub — 0.3 and 0.4 share the payload-bound §9.2 signature. Tying the threshold to the implemented minor
  would have wrongly rejected 0.3 push once the Hub advanced to 0.4; spec §10 states the anchor explicitly.

### Changed (breaking, pre-1.0)
- **Renamed to MA2H — Multi-agent to Human Protocol ("Mash").** The lineage is **A2H → AHCP → MA2H**: the
  intermediate name (AHCP) collided with an existing protocol, so — still with no external adopters — the
  protocol was renamed again, in full, in a single clean cut. The rename moves the name, every wire
  identifier (message version field, signature header, callback-secret env convention, discovery path,
  sensitive-field schema extension, state-seal magic), all schema `$id`s, the `ma2h.org` domain,
  and the distribution names (npm package, CLI binary, plugin/marketplace, GitHub repo). No compatibility
  layer is kept — `a2h` and `ahcp` are gone from the wire surface. **Protocol semantics are unchanged** —
  same three verbs, message envelope, lifecycle, and RFC 8785 JCS + HMAC/ed25519 signature *algorithm*. The
  conformance vectors were re-signed because the version field (`ma2h_version`) is one of the bytes inside
  the canonical `signed_context` (and renaming it re-sorts its position in the JCS key order). Verified by
  the reference suite (56/0). See [MIGRATION.md](MIGRATION.md) for the full before/after identifier table.
- **Frozen-identifier guard now whole-word matches the retired tokens.** Because the live identity `MA2H`
  literally contains `A2H` (e.g. `ma2h_version` ⊃ `a2h_version`, `MA2HSEALv1` ⊃ `A2HSEALv1`),
  `scripts/check-frozen-identifiers.sh` uses `grep -wF` for the forbidden list — it rejects a standalone
  retired token while ignoring the `a2h` that legitimately lives inside `ma2h`. The forbidden list now
  covers both retired identities (`a2h` and `ahcp`).

### Changed
- **`ma2h-skills` plugin templates migrated to v0.3.** The `implement` / `build-notify` / `build-ask` /
  `build-task` skills now target `ma2h_version: "0.3"`, link the v0.3 spec/schema, and the push
  verification guidance recomputes `payload_sha256` and reconstructs the v0.3 §9.2 `signed_context`
  (payload-bound signature). Previously the templates emitted `ma2h_version: "0.2"`, so following them
  with a **push** callback against a current v0.3 Hub broke (the Hub rejects pre-0.3 push with
  `version_not_supported`, §10). Generated sender skills now interoperate with a current Hub on push.

### Added
- **Reference Hub version negotiation (§10).** The reference Hub now rejects a message whose `ma2h_version`
  **major** it doesn't recognize with `version_not_supported`, and rejects a **pre-0.3 push** request (its
  pushed Response is signed with the v0.3 payload-bound signature, which a pre-0.3 agent cannot verify) —
  **pull stays compatible** (§8.2, pull responses aren't signature-verified). Spec §10 gains the
  push-version-parity rule; `pa-001` records the downstream-proof obligation. (#9)
- **Numeric-payload conformance proof for `payload_sha256` (§9.2).** New `dp-004` vector pins the canonical
  RFC 8785 JCS + digest for a numeric `{ response, state }` (integer / negative / fraction / `1e-7` /
  `1e+21` / max-safe int / nested), so cross-language signers can prove byte-agreement. Spec §9.2 clarifies that
  numbers canonicalize as IEEE-754 doubles (ordinary decimals included; non-JS impls MUST use a conformant
  JCS library and MUST preserve strings — RFC 8785 §3.1 does not normalize Unicode), with an exactness
  caveat that an integer beyond ±(2^53−1) MUST be carried as a string; `pa-001` records the obligation. (#10)

## 0.3 (2026-06-12) — Draft

**Binds the response payload into the detached Response signature (§9.2).** A breaking signature change: the
canonical `signed_context` now includes `payload_sha256`, a digest of the response payload, so a tampered
answer is rejected end-to-end (independent of transport).

### Breaking changes
- **§9.2 signature binds `payload_sha256`.** The detached Response signature now covers a lowercase-hex
  SHA-256 of JCS(`{ response, state }`) — binding `response.value` / `comment` / `actor` / `edited` /
  `resolved_at` and the round-tripped `state`. Before v0.3 the answer `value` for a `select`/`input` ask was
  unsigned, so a MITM or TLS-terminating proxy could flip it (e.g. `hold` → `ship`) and verification still
  returned ok (#7). The Hub MUST sign over the payload it delivers; the agent MUST **recompute** the digest
  from the payload it received and verify. A v0.2 verifier and a v0.3 signer compute different canonical
  strings — there is no signature interop across this break within major `0`. New `spec/v0.3.md` +
  `schema/v0.3/`; the reference impl and conformance vectors move to v0.3; `dp-001` is extended with the
  bound payload and new `dp-003-payload-tamper-invalid` proves a tampered `value` fails verification.

### Changed
- **`body` schema now declares `contentMediaType: "text/markdown"`** so consumers validating against the
  JSON Schema alone see the Markdown contract the spec already mandates (§9.6). Annotation-only and
  non-validating — every previously-valid message stays valid and the schema `$id` is unchanged. (Body
  length remains capability-advertised via `max_body_bytes`, deliberately not a schema `maxLength`.)
- **§9.1 now binds `cancel` — not only poll/callback — to the submitting principal.** The request-leg
  auth rule names `POST /v1/messages/{id}/cancel` (§8.4) explicitly, closing a literal-conformance gap
  where a Hub could let one authenticated agent terminally withdraw another agent's open `ask` by guessing
  its `id`. Non-breaking: it surfaces the existing "`run_id` MUST NOT authorize cross-run access" contract
  — the prior `poll/callback` enumeration was illustrative, not an exhaustive grant — and cancel, being
  state-terminating, is the most sensitive of the three. No schema `$id` / version-path change. A
  non-submitting principal SHOULD see the id as unknown (`404`), so the binding doubles as an
  id-enumeration guard. §8.4 updated to match; conformance `pa-001` gains the assert and new
  `dp-002-cancel-submitter-binding` records the Hub's proof obligation; the reference Hub now enforces it.
- **§7 makes the expiry-vs-cancel ordering explicit.** A cancel arriving strictly after `expires_at` loses
  to `default_on_expire` against the same clock as expiry-vs-answer, so an overdue `ask` resolves to
  `expired`, never `cancelled` — the reference Hub now applies the default-expiry precedence in `cancel()`
  exactly as it already did in `resolve()`.

### Process
- Added `CONTRIBUTING.md`, a spec-change-aware PR template, and an SCP (Spec Change Proposal) issue
  template — codifying the contribution process (editorial-PR vs. SCP split, BCP 14 normative language,
  SemVer + `$id` discipline, mandatory security considerations, conformance/reference obligations, DCO
  sign-off). Modeled on MCP SEP, Rust RFC, Python PEP, and IETF conventions.

## 0.2 (2026-06-03) — Draft

**A breaking hardening pass.** v0.2 resolves the trust-model, return-leg, concurrency, and durability gaps
found in the v0.1 design review. v0.1 was an unadopted draft, so this is the right time to break.

### Breaking changes
- **Hub-canonical ids.** `id` is now Hub-assigned (returned in the 202 ack), not agent-supplied. Agents
  use the new optional `client_ref` label for their own correlation.
- **`idempotency_key` is REQUIRED for `ask`/`task`** (was MAY). With Hub-assigned ids, it is the only
  thing preventing a duplicate human decision when a 202 is lost.
- **Resolution enum locked.** `ask` → `answered|declined|cancelled|expired`; `task` →
  `completed|dismissed|expired`. The orphan `ignored` value is **removed** (an ignored ask resolves
  `declined`); `cancelled` is **ask-only**.
- **`state` is now a first-class request field** and MUST be integrity-sealed by the agent.

### Added (closing v0.1 P0s)
- **Response envelope schema** (`response.schema.json`) — the return leg is now validatable.
- **Response integrity for all callback schemes** — a detached signature over RFC 8785 JCS of a defined
  `signed_context`, `jti` nonce + receiver replay cache, ±120s Hub-clock window, bound to id + resolution_id + url.
- **State-seal key provenance** — per-agent, Hub-invisible, distinct from the callback credential, never
  in `state`; the embedded-key anti-pattern is called out.
- **Hub-attested `actor`** + per-message `allowed_resolvers` with a **fail-closed default**.
- **SSRF controls** — callback-host ownership verification, private-range refusal at delivery time
  (DNS-rebinding defense), no redirects, credential-host binding. The GitHub-PAT example is replaced and
  re-published as a confused-deputy anti-pattern.
- **Atomic single-writer lifecycle** — first-terminal-wins, expiry-vs-answer precedence, `resolution_id`
  dedup, at-most-once delivery.
- **Reliability** — durability as a conformance MUST (including `delivered` notifies), pull-available
  retention (default 30 days), 410 vs 404, mandated receiver dedup.
- **Error model** (§8.5), **rate/quota/size limits** (§8.6), **discovery endpoint** `GET /.well-known/ma2h`
  (§8.0) + `capability.schema.json`, **submit-ack** and **get-message** schemas.
- **Ephemeral agent resume pattern** (§2.1) — the exit→reinvoke→reconstruct flow is now normative.
- **Conformance vectors** with three explicit verification classes (schema-validation / prose-audit /
  downstream-proof) so green vectors don't over-claim closure of the security/concurrency P0s.

### Notes
- Terminology disambiguated: `status` (lifecycle) vs `resolution` (terminal outcome) vs `state` (opaque
  agent blob).
- The security/concurrency controls are **specified** here; closure is proven against a conformant
  reference Hub, which is downstream of this spec (see §12).

## 0.1 (2026-06-03) — Draft, superseded

Initial draft: three verbs (`notify`/`ask`/`task`), hub-and-spoke, push/pull callbacks. Superseded by 0.2.
