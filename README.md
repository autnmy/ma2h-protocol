# A2H — Agent-to-Human Protocol

> **Status:** Draft · **Version:** 0.2 · **Steward:** Autonomy · **License:** Apache-2.0
> A vendor- and runtime-neutral protocol for agents to reach a human and get a decision back.

## The one-line pitch

Where **MCP** standardizes agent↔tools and **A2A** standardizes agent↔agent, **A2H** standardizes
**agent↔human**: a hub-and-spoke model where heterogeneous agents (local, cloud, CLI, GitHub Actions,
desktop) POST three kinds of message — `notify`, `ask`, `task` — to a central **Hub** that a human
triages from one place, and where answers to an `ask` or `task` route back to the originating
(often ephemeral or paused) agent via **push** webhook or **pull** polling.

```
   MCP  →  agent ↔ tools
   A2A  →  agent ↔ agent
   A2H  →  agent ↔ human     ← this spec
```

## Why this exists

As of mid-2026 there is **no open, adoptable protocol** for a central human-triage inbox across a
heterogeneous agent fleet. The closest things are single-vendor primitives (MCP elicitation, LangGraph
`interrupt`), framework-locked SDKs (HumanLayer, Microsoft Agent Framework), or proprietary products
(PagerDuty SRE Agent, Salesforce Agent Fabric). A2A models the *agent* side of a handoff
(`input-required`) but explicitly leaves the human-hub layer to the application. A2H fills exactly that gap.

## Three verbs

| Verb | Meaning | Response expected? | Example |
|------|---------|--------------------|---------|
| `notify` | FYI / summary / status update | No | The daily executive dev-team digest |
| `ask` | A decision the human must make; the agent acts on the answer | Yes — a choice or structured input, routed back | "Ship to prod now, or hold for review? A/B/C" |
| `task` | A manual action a human must perform out-of-band | Optional completion signal | "Rotate the API signing key, then mark done" |

## Non-NIH by design

A2H deliberately reuses conventions from prior art so adopters aren't learning a wholly new vocabulary:

- **A2A** — message/part schema, `PushNotificationConfig` auth shapes, `contextId` grouping, task-state vocabulary.
- **HITL Protocol** (`rotorstar/hitl-protocol`) — the `202 Accepted` + `poll_url`/`review_url` handshake.
- **MCP elicitation** — `enum`/`enumNames` structured choices, `accept`/`decline`/`cancel` outcomes, flat schemas for renderability.
- **HumanLayer** — opaque `state` round-trip so stateless agents can resume; typed contact channels.
- **LangGraph** — `HumanInterruptConfig` permission flags.
- **CHEQ** (IETF draft) — keep human-entered secrets out of the agent's LLM context.

See [`spec/v0.2.md` §11](spec/v0.2.md) for full provenance.

## Repo layout

```
README.md                          ← you are here
CHANGELOG.md                       ← v0.1 → v0.2 migration notes
spec/v0.2.md                       ← the normative specification (current)
spec/v0.1.md                       ← superseded draft (kept for history)
schema/v0.2/
  message.schema.json              ← request leg (agent → Hub)
  response.schema.json             ← return leg (Hub → agent)
  submit-ack.schema.json           ← 202 ack body
  get-message.schema.json          ← GET /v1/messages/{id} body
  capability.schema.json           ← GET /.well-known/a2h discovery doc
examples/                          ← concrete envelopes (notify/ask/task + responses + the resume callback)
conformance/                       ← vector format, the three verification classes, starter vectors
reference/                         ← @a2h/reference — vendor-neutral TypeScript reference impl + `a2h` CLI
plugins/a2h-skills/                ← installable plugin: implement a Hub + build notify/ask/task skills
```

## Stewardship & governance

**A2H is stewarded by Autonomy** and licensed [Apache-2.0](LICENSE). It is deliberately structured
to read as a neutral, donate-able standard — not a single-vendor artifact — because open protocols only
get adopted when implementers' legal teams can clear the patent risk (the reason A2A moved to the Linux
Foundation within two months of launch). See [GOVERNANCE.md](GOVERNANCE.md) for the full model.

**Protocol vs. product — a deliberate split:**

| | What it is | Owner | License / model |
|---|---|---|---|
| **A2H** (this repo) | The open spec + schema | Stewarded by Autonomy, donate-able | Apache-2.0, DCO contributions |
| **The Hub** (separate) | The hosted server + native triage app | Autonomy LLC commercial product | Proprietary |

Autonomy authors the standard *and* sells the best implementation of it. The standard stays neutral so it
can be adopted; the product is unambiguously commercial.

**Path to "official":**

1. Self-publish (spec + schema + reference impl + docs), Apache-2.0, DCO on contributions — the path MCP took.
2. Reference client #1 = a real agent fleet dogfooding the daily digest as `notify` message #1.
3. Bring to the **W3C AI Agent Protocol Community Group** (exists since May 2025) for a recognized-body banner + royalty-free patent commitments.
4. Donate governance to a neutral home (Linux Foundation / **Agentic AI Foundation**, which now houses MCP) once there is adoption worth governing.

Adoption first, governance second — the proven order.

## Name (locked)

The protocol is **A2H — Agent-to-Human Protocol**, chosen as the legible complement to A2A (agent↔agent):
`MCP → agent↔tools · A2A → agent↔agent · A2H → agent↔human`. The name captures the agent-*initiated*
direction and slots into a family implementers already recognize.

Rejected: **HAI / AHI** ("oh hai") — collides with the prominent *Stanford HAI* (Human-Centered AI
Institute), and the meme framing undercuts the gravitas an open standard needs for enterprise adoption.
The playful "hai" voice instead lives in the **product** layer (the Hub app), not the protocol.
**Loop** — collides with Microsoft Loop et al.
