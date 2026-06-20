# Migration — A2H → AHCP

The protocol was renamed from **A2H — Agent-to-Human Protocol** to **AHCP — Agent Human Coordination
Protocol**. Because there were no external adopters yet, this was a **complete, clean rename**: the brand,
the wire format, the schema identifiers, the domain, and the distribution names all moved to `ahcp` in a
single cut. There is no `a2h` compatibility layer to maintain — `a2h` survives only in this document and
the historical records (`CHANGELOG`, `docs/`).

## What changed

Every identifier moved from `a2h`/`A2H` to `ahcp`/`AHCP`:

| Layer | Before | After |
|-------|--------|-------|
| Name | A2H — Agent-to-Human Protocol | AHCP — Agent Human Coordination Protocol |
| Message version field | `a2h_version` | `ahcp_version` |
| Signature header | `A2H-Signature` | `AHCP-Signature` |
| Callback-secret env convention | `A2H_CALLBACK_SECRET` | `AHCP_CALLBACK_SECRET` |
| Discovery endpoint | `GET /.well-known/a2h` | `GET /.well-known/ahcp` |
| Sensitive-field schema extension | `x-a2h-sensitive` | `x-ahcp-sensitive` |
| State-seal magic prefix | `A2HSEALv1` | `AHCPSEALv1` |
| Schema `$id` host + website | `a2hprotocol.org` | `ahcpprotocol.org` |
| npm package | `@a2h/reference` | `@ahcp/reference` |
| CLI binary | `a2h` | `ahcp` |
| Plugin / marketplace | `a2h-skills` · `@a2h` | `ahcp-skills` · `@ahcp` |
| GitHub repository | `autnmy/a2h-protocol` | `autnmy/ahcp-protocol` |

## What did NOT change

The protocol **semantics** are identical — same three verbs (`notify` / `ask` / `task`), same message
envelope, same response/lifecycle model, same RFC 8785 JCS + HMAC-SHA256 / ed25519 signature *algorithm*,
same security model. Only the *identifiers* were renamed. The conformance vectors were re-signed because
the version field (`ahcp_version`) is one of the bytes inside the canonical `signed_context`; the signing
algorithm itself is unchanged, and the reference suite verifies the new fixtures.

## Disambiguation: the phrase "agent-to-human"

"AHCP" replaces "A2H" and "Agent-to-Human Protocol" **as the proper-noun name of the protocol**. The
phrase "agent-to-human" / "agent ↔ human" used as a *plain-English description of direction* — e.g.
"AHCP standardizes how agents coordinate with humans" — is descriptive and stays.

## For implementers

There are no external adopters, so there is nothing to migrate in production. If you have a local
experiment built against A2H, rename the identifiers per the table above and re-pull `@ahcp/reference`.
There is no dual-running or deprecation window — `a2h` is simply gone.
