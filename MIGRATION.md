# Migration — the protocol is now MA2H

The protocol's name is **MA2H — Multi-agent to Human Protocol** (reads as *"Mash"*). It reached that name
through two pre-1.0 renames, each a **complete, clean cut** made while there were **no external adopters**:

- **A2H — Agent-to-Human Protocol** (original)
- → **AHCP — Agent Human Coordination Protocol** (short-lived; the name collided with an existing protocol)
- → **MA2H — Multi-agent to Human Protocol** (current)

Each rename moved the brand, every wire identifier, the schema `$id`s, the domain, and the distribution
names together. There is **no compatibility layer**: `a2h` and `ahcp` survive only in this document and the
historical records (`CHANGELOG`, `docs/`). Everything on the wire is `ma2h`.

## Why "MA2H" / "Mash"

The name describes the protocol on three layers at once:

- **Topology** — *multi-agent → human*: many agents fan in to one human, which is exactly the
  hub-and-spoke shape MA2H standardizes.
- **The problem** — it literally names what the protocol exists to solve: coordinating *many* agents with
  *a* human.
- **Reads as "Mash"** — one syllable, memorable, and apt: a hub *mashes together* — aggregates,
  reconciles, brings into one place — every agent's `notify` / `ask` / `task`.

> **Not Twilio's A2H.** `MA2H` contains the substring `A2H`, and "agent-to-human" is a generic phrase. An
> unrelated, separately-published *A2H* proposal concerns *addressing* a specific human across messaging
> channels. MA2H is a different thing — the multi-agent **coordination hub** a fleet shares with a human —
> and is neither derived from nor compatible with it. See the README's "When to use MA2H".

## The rename map (final identifiers)

| Layer | Final — MA2H | Former — AHCP | Original — A2H |
|-------|--------------|---------------|----------------|
| Name | MA2H — Multi-agent to Human Protocol | AHCP — Agent Human Coordination Protocol | A2H — Agent-to-Human Protocol |
| Message version field | `ma2h_version` | `ahcp_version` | `a2h_version` |
| Signature header | `MA2H-Signature` | `AHCP-Signature` | `A2H-Signature` |
| Callback-secret env convention | `MA2H_CALLBACK_SECRET` | `AHCP_CALLBACK_SECRET` | `A2H_CALLBACK_SECRET` |
| Discovery endpoint | `GET /.well-known/ma2h` | `GET /.well-known/ahcp` | `GET /.well-known/a2h` |
| Sensitive-field schema extension | `x-ma2h-sensitive` | `x-ahcp-sensitive` | `x-a2h-sensitive` |
| State-seal magic prefix | `MA2HSEALv1` | `AHCPSEALv1` | `A2HSEALv1` |
| Schema `$id` host + website | `ma2h.org` | `ahcpprotocol.org` | `a2hprotocol.org` |
| npm package | `@ma2h/reference` | `@ahcp/reference` | `@a2h/reference` |
| CLI binary | `ma2h` | `ahcp` | `a2h` |
| Plugin / marketplace | `ma2h-skills` · `@ma2h` | `ahcp-skills` · `@ahcp` | `a2h-skills` · `@a2h` |
| GitHub repository | `autnmy/ma2h-protocol` | `autnmy/ahcp-protocol` | `autnmy/a2h-protocol` |

## What did NOT change

The protocol **semantics** are identical across all three names — same three verbs
(`notify` / `ask` / `task`), same message envelope, same response/lifecycle model, same RFC 8785 JCS +
HMAC-SHA256 / ed25519 signature *algorithm*, same security model. Only the *identifiers* were renamed. The
conformance vectors were re-signed at each rename because the version field (`ma2h_version`) is one of the
bytes inside the canonical `signed_context`; the signing algorithm itself is unchanged, and the reference
suite verifies the current fixtures (56/0).

## Disambiguation: the phrase "agent ↔ human"

"MA2H" is the proper-noun name of the protocol. The phrase "agent-to-human" / "multi-agent to human" used
as a *plain-English description of direction* — e.g. "MA2H standardizes how agents coordinate with humans"
— is descriptive and stays.

## For implementers

There are no external adopters, so there is nothing to migrate in production. If you have a local
experiment built against A2H or AHCP, rename the identifiers per the table above and re-pull
`@ma2h/reference`. There is no dual-running or deprecation window — `a2h` and `ahcp` are simply gone.

## v0.3 → v0.4 (the inbound leg)

v0.4 is a **version bump, not a rename** — and it is **additive and backward-compatible** (a MINOR bump
under major `0`). It adds the **human→agent** leg (the [`directive`](spec/v0.4.md); §13) alongside the
unchanged v0.3 agent→human legs. Unlike the renames above, **nothing is removed or changed on the existing
wire**:

- Every v0.3 leg — `notify` / `ask` / `task` and their Responses — is **byte-for-byte unchanged**. A 0.4
  Hub accepts 0.3 agent→human envelopes and signs their Responses at the `ma2h_version` carried; the §9.2
  signature algorithm is identical.
- The agent→human schemas in `schema/v0.4/` are the `schema/v0.3/` schemas re-`$id`'d to the v0.4 path,
  same shape. `capability` gains an optional `inbound` object; the new `inbound-message.schema.json` is
  added. `spec/v0.3.md` + `schema/v0.3/` remain on disk as the v0.3 snapshot.
- **What's new to adopt (opt-in):** the directive envelope (§13.1), the `/v1/inbox` drain/ack transport
  (§8.7), and the §9.7 directive signature. A pre-0.4 agent that does not consume the inbound leg keeps
  working unchanged — the leg is optional to offer and to consume (§1).
- **One reference correctness fix the bump surfaced:** the pre-0.3-push parity threshold is now anchored at
  the signature-break minor (3), not "the highest implemented minor," so a 0.4 Hub still accepts a 0.3 push
  (0.3 and 0.4 share the payload-bound signature) while still rejecting a pre-0.3 push.

For a local experiment already on v0.3: bump `ma2h_version` to `"0.4"` when you want to send/consume
directives, point `$ref`s at `schema/v0.4/`, and re-pull `@ma2h/reference`. If you only use the agent→human
legs, you can stay on `"0.3"` against a 0.4 Hub — that is exactly the backward-compatibility guarantee.
