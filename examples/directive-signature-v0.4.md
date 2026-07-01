# Worked example — the v0.4 directive signature (§9.7)

This shows how a Hub signs a **human→agent directive** delivery in **v0.4** — the inbound mirror of the
§9.2 Response signature. The detached signature binds `payload_sha256` (a digest of the instruction the
agent consumes) plus the top-level `from`, `id`, and `to`, so a tampered or cross-agent-replayed directive
fails verification.

The values below are the deterministic conformance fixture
[`conformance/vectors/dp-005-inbound-signature.json`](../conformance/vectors/dp-005-inbound-signature.json);
the tamper negative is [`dp-006`](../conformance/vectors/dp-006-inbound-tamper-invalid.json). Reproduce them
with `npm run vectors`.

## 1. The directive the agent drains

See [`directive-inbound.json`](directive-inbound.json) — a `human:alice` → `agent:deploybot/dev-team`
directive (`id` `dir_01HZXDIR0001`).

## 2. `payload_sha256` — lowercase-hex SHA-256 of JCS(`{ directive: <content> }`)

The content object carries exactly the present `title`, `body`, `priority`, `tags`, and `context` fields
(Hub/transport metadata — `id`, `from`, `to`, `created_at` — is excluded; `from`/`id`/`to` are bound as
top-level signed fields instead):

```
{"directive":{"body":"We are mid-incident on prod. Hold all deploys until I say otherwise.","priority":"urgent","tags":["incident","deploy-freeze"],"title":"Pause deploys until the incident is resolved"}}

payload_sha256 = 73a4c4c78425ebb286d36fe12905fab35eb07adf38166940137872b43fef0483
```

## 3. The canonical `inbound_signed_context` (RFC 8785 JCS)

```
{"from":"human:alice","id":"dir_01HZXDIR0001","jti":"jti_01HZXDIRDEMOFIX","ma2h_version":"0.4","payload_sha256":"73a4c4c78425ebb286d36fe12905fab35eb07adf38166940137872b43fef0483","t":"1782043200","to":"agent:deploybot/dev-team"}
```

## 4. The wire header (HMAC-SHA256 over the canonical string)

With test key `ma2h-test-secret-key-0123456789ab`:

```
MA2H-Signature: t=1782043200,jti=jti_01HZXDIRDEMOFIX,v1=Bh6zPUfvl_p3SJdgxCPEPgEKZ9VyvXbl8yRKDGzufSk
```

The Hub re-signs each delivery with a **fresh** `t` and `jti` (§9.7), so a directive that rests in the
mailbox for hours still arrives inside the agent's replay window; only `t`/`jti` change per delivery.

## 5. What the agent does on receipt

1. Parse the `MA2H-Signature` header (`t`, `jti`, `v1`).
2. **Recompute** `payload_sha256` from the directive it actually received, and re-read the bound `from`,
   `id`, and `to` from that directive — never trust a transmitted digest.
3. Rebuild the canonical `inbound_signed_context` and verify `v1` (HMAC-SHA256), rejecting a `t` outside the
   replay window and any replayed `jti`.
4. **Deduplicate** on the directive `id` and act at most once (at-least-once delivery can present the same
   `id` again), then `POST /v1/inbox/ack` to consume it.

Because the agent recomputes the digest and re-reads `from`/`to` from the received directive, a proxy that
alters the instruction `body`, spoofs `from`, or redirects `to` another agent produces a different canonical
string and therefore a signature mismatch — a directive signed for `agent:deploybot/dev-team` cannot be
replayed into `agent:victim/other-bot`'s mailbox.
