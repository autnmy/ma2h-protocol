# Worked example — the v0.3 payload-bound Response signature (§9.2)

This shows how a Hub signs a pushed Response in **v0.3**, where the detached signature binds
`payload_sha256` — a digest of the response payload — so a tampered answer fails verification (issue #7).

The values below are the deterministic conformance fixture
[`conformance/vectors/dp-001-signature.json`](../conformance/vectors/dp-001-signature.json); the
`payload-tamper` negative is [`dp-003`](../conformance/vectors/dp-003-payload-tamper-invalid.json). Reproduce
them with the reference CLI (`ahcp sign`) or `npm run vectors`.

## 1. The Response payload the agent consumes

```json
{
  "response": {
    "value": "hold",
    "edited": false,
    "actor": "human:alice",
    "resolved_at": "2026-06-04T15:48:30Z",
    "comment": "Let's get a human eye on the migration first."
  },
  "state": { "sealed": "v1.demo.MOCK-SEALED-STATE-BLOB" }
}
```

## 2. `payload_sha256` — lowercase-hex SHA-256 of JCS(`{ response, state }`)

```
payload_sha256 = 3073dec57c04075d0b6bfa17c300fa9600ad92fb13e485e410c8a95274ac47ed
```

The digest covers the **entire** `response` detail (`value`, `edited`, `actor`, `resolved_at`, `comment`)
and the round-tripped `state`. Absent members are serialized as `null` in the fixed-key wrapper.

## 3. The canonical `signed_context` (RFC 8785 JCS)

```
{"ahcp_version":"0.3","callback_url":"https://deploybot.example/ahcp/resume","id":"msg_01HZXASK0001","in_reply_to":"msg_01HZXASK0001","jti":"jti_01HZX7Q9Z3DEMOFIX","payload_sha256":"3073dec57c04075d0b6bfa17c300fa9600ad92fb13e485e410c8a95274ac47ed","resolution":"answered","resolution_id":"res_01HZXR3SOLVE","resolved_at":"2026-06-04T15:48:30Z","t":"1749050910"}
```

## 4. The wire header (HMAC-SHA256 over the canonical string)

With test key `ahcp-test-secret-key-0123456789ab`:

```
AHCP-Signature: t=1749050910,jti=jti_01HZX7Q9Z3DEMOFIX,v1=sGsoX7pEgPVFL24v4qocBp586SLQGWoh8Qt46LlSfPc
```

## 5. What the agent does on receipt

1. Parse the `AHCP-Signature` header (`t`, `jti`, `v1`).
2. **Recompute** `payload_sha256` from the `response` + `state` it actually received — never trust a
   transmitted digest.
3. Rebuild the canonical `signed_context` with that recomputed digest and verify `v1` against it
   (HMAC-SHA256), rejecting a `t` outside ±120s and any replayed `jti`.

Because the agent recomputes the digest from the received payload, a man-in-the-middle or TLS-terminating
proxy that flips `response.value` (`hold` → `ship`) — leaving the metadata and the `AHCP-Signature` header
untouched — produces a different `payload_sha256`, a different canonical string, and therefore a signature
mismatch. The forged answer is rejected. (State integrity against a *malicious Hub* that can re-sign remains
the agent's own AEAD seal, §9.3 — the two layers are complementary.)
