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

## v0.4 → v0.5 (the inter-agent leg)

v0.5 is a **version bump, not a rename** — **additive and backward-compatible** (a MINOR bump under
major `0`, via [SCP #24](https://github.com/autnmy/ma2h-protocol/issues/24)). It adds the
**inter-agent leg** — [sessions](spec/v0.5.md) (§16), addressed envelopes (`to`, §4), three mailbox
entry kinds (§8.7), the §9.8 entry signatures, and delivery honesty (§14.2) — alongside the unchanged
v0.4 legs. Nothing is removed or changed on the existing wire:

- Every v0.3/v0.4 leg — `notify`/`ask`/`task`, Responses, directives, acks, presence — is
  **byte-for-byte unchanged**. A 0.5 Hub accepts 0.3/0.4 envelopes and signs at the version carried;
  the §9.2/§9.7 algorithms and the push-parity threshold (minor 3) are identical.
- The `schema/v0.5/` snapshot is the `schema/v0.4/` schemas re-`$id`'d to the v0.5 path, with the
  listed extensions only: `message` gains optional `to` + `agent.session`; the **closed** `submit-ack`
  schema lists two additions (`status: "queued"` and the `destination` snapshot — a deliberate, named
  change, not a silent carry-forward); `get-message` carries the v0.5 delivery-track states;
  `capability` gains `sessions`/`inter_agent` + the `inbound` stream/session fields;
  `inbound-message.schema.json` becomes the four-kind delivered-entry union (a v0.4 directive still
  validates); `session.schema.json` is added. `spec/v0.4.md` + `schema/v0.4/` remain on disk as the
  v0.4 snapshot.
- **What's new to adopt (opt-in, per role):** a *sender* feature-detects `inter_agent` (§8.0), adds
  `to` (and SHOULD register a session + carry `agent.session`), and honors the §8.1 queued-ack /
  `destination` / misroute rules; a *recipient* registers a session, drains with `?session=`, verifies
  the §9.8 entry signatures, applies the §13.4 duties (session-qualified addressee check + a declared
  sender policy), and acks; an *operator* opts the account in (`inter_agent.enabled`) and gains the
  §16 session kill-switch. A pre-0.5 agent that never presents a session never sees a new entry kind
  and keeps working unchanged — the leg is optional to offer and to consume (§1).
- **Two deliberate louder-failure changes to know about:** (1) a 0.5 Hub **rejects** (`422
  unknown_destination` / `410 destination_gone`) directive submissions to unknown or terminal
  destinations that a 0.4 Hub accepted and silently dead-lettered (§4's retroactive validation —
  failing submissions now fail visibly); (2) a 0.5 **sender** MUST treat an addressed-submit ack
  lacking `destination` as a pre-0.5 misroute (§8.1) — capability caching alone is TOCTOU across
  rolling deploys.

For a local experiment already on v0.4: bump `ma2h_version` to `"0.5"` when you want the inter-agent
leg, point `$ref`s at `schema/v0.5/`, and re-pull `@ma2h/reference`. If you only use the
agent→human/human→agent legs, you can stay on `"0.4"` against a 0.5 Hub — the same guarantee as every
MINOR before it.
