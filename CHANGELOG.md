# Changelog

All notable changes to the AHCP (Agent Human Coordination Protocol) specification.

## Unreleased

### Changed (breaking, pre-1.0)
- **Complete rename: A2H → AHCP.** With no external adopters yet, the protocol was renamed in full — its
  name, every wire identifier (message version field, signature header, callback-secret env convention,
  discovery path, sensitive-field schema extension, state-seal magic), all schema `$id`s, the
  `ahcpprotocol.org` domain, and the distribution names (npm package, CLI binary, plugin/marketplace,
  GitHub repo) — in a single clean cut, with no compatibility layer kept. **Protocol semantics are
  unchanged** — same three verbs, message envelope, lifecycle, and RFC 8785 JCS + HMAC/ed25519 signature
  *algorithm*. The conformance vectors were re-signed because the version field is one of the bytes inside
  the canonical `signed_context`. Verified by the reference suite (56/0). See [MIGRATION.md](MIGRATION.md)
  for the full before/after identifier table.

### Changed
- **`ahcp-skills` plugin templates migrated to v0.3.** The `implement` / `build-notify` / `build-ask` /
  `build-task` skills now target `ahcp_version: "0.3"`, link the v0.3 spec/schema, and the push
  verification guidance recomputes `payload_sha256` and reconstructs the v0.3 §9.2 `signed_context`
  (payload-bound signature). Previously the templates emitted `ahcp_version: "0.2"`, so following them
  with a **push** callback against a current v0.3 Hub broke (the Hub rejects pre-0.3 push with
  `version_not_supported`, §10). Generated sender skills now interoperate with a current Hub on push.

### Added
- **Reference Hub version negotiation (§10).** The reference Hub now rejects a message whose `ahcp_version`
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
- **Error model** (§8.5), **rate/quota/size limits** (§8.6), **discovery endpoint** `GET /.well-known/ahcp`
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
