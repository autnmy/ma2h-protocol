# MA2H — Multi-agent to Human Protocol

> **Status:** Draft · **Version:** 0.4 · **Steward:** Autonomy · **License:** Apache-2.0
> A vendor- and runtime-neutral protocol that standardizes how autonomous agents coordinate with a human.

## Overview

**MA2H standardizes how autonomous agents coordinate with humans.** A fleet of agents — running across
different runtimes, machines, models, and environments — needs one consistent way to reach a person:
to inform them, to ask them for a decision, or to hand them a real-world task. MA2H defines that
interface as a hub-and-spoke model: heterogeneous agents POST three kinds of message — `notify`, `ask`,
`task` — to a central **Hub** where humans coordinate from one place, and answers route back to the
originating (often ephemeral or already-exited) agent via **push** webhook or **pull** polling.

The shape is many-to-one: a fleet of agents converges on a single hub, and every signed answer routes
back to the originating agent — even one that has already exited.

As of **v0.4**, the hub is bidirectional: a human can also send a **directive** — an instruction or FYI —
addressed to one specific agent, which the agent drains from a durable per-agent mailbox (signed, verified,
at-least-once) using the same pull-first / webhook-optional mechanism as the return leg. This is additive
and backward-compatible — every v0.3 leg is unchanged. See [`spec/v0.4.md` §13](spec/v0.4.md).

```
   agent ┐
   agent ┤
   agent ┼──▶  [ MA2H hub ]  ──▶  human
   agent ┤
   agent ┘
          ◀──  signed answer routed back to the agent
```

## The problem

A large fleet of autonomous agents has no standard way to coordinate with the humans who supervise it.
Each runtime invents its own mechanism, so a human supervising many agents faces many incompatible
inboxes, and an agent written for one environment cannot reach a human through another. Existing
building blocks address only part of the problem: single-vendor primitives (MCP elicitation, LangGraph
`interrupt`), framework-bound SDKs, and proprietary products each solve human-in-the-loop *within* their
own boundary. A2A models the *agent* side of a handoff (`input-required`) but explicitly leaves the
human-hub layer to the application.

MA2H fills that gap: an open, vendor-neutral, runtime-neutral interface for a central human-triage inbox
across a heterogeneous agent fleet — durable coordination that does not depend on any one model,
runtime, or implementation.

## The three verbs

| Verb | Meaning | Response expected? | Example |
|------|---------|--------------------|---------|
| `notify` | Keep a human informed — FYI, summary, status, digest. | No | A daily executive dev-team digest |
| `ask` | A decision the human must make before the agent proceeds; the agent acts on the answer. | Yes — a choice or structured input, routed back | "Ship to prod now, or hold for review? A/B/C" |
| `task` | A manual action a human must perform out-of-band. | Optional completion signal | "Rotate the API signing key, then mark done" |

## The Hub

The Hub is the single coordination surface for a fleet. One human (or a small on-call group) triages
every agent's messages from one place. The Hub serves as:

- a **universal inbox** — every agent's `notify`/`ask`/`task` lands in one queue;
- a **routing layer** — answers return to the correct originating agent, by push or pull;
- a **persistence layer** — messages and decisions are durable, so an agent that has exited can resume
  when its answer arrives;
- a **decision-collection layer** — human choices and task completions are captured as structured,
  signed responses.

Agents are "spokes": any process in any runtime that can make an HTTP request can participate. They need
not be long-lived — the **ephemeral agent resume pattern** (spec §2.1) is a first-class flow: an agent
asks, exits, and a fresh process resumes when the human answers.

## Use cases

- A fleet of CI, cron, cloud, desktop, and CLI agents that all need to reach the same on-call human.
- An agent that must pause for a human decision (approve a deploy, choose an architecture, confirm a
  destructive action) and resume after exiting.
- Routine human-in-the-loop touchpoints: daily digests, incident summaries, "please upload X", "please
  sign Y", "please contact this vendor".

## Non-goals

MA2H is a **coordination protocol**, not:

- a chatbot or conversational protocol;
- an approval-workflow product or BPM engine;
- a messaging application;
- a UI framework.

It does not mandate a transport beyond an HTTP/JSON binding, a storage engine, or a user interface. It
defines the message contract and the trust rules; implementations choose everything else.

## When to use MA2H

Agent-coordination protocols solve different problems — choose by the *shape* of the problem, not the
participants:

- **A2A (Agent2Agent)** — an agent coordinating with *other agents*: peer-to-peer task handoff between
  autonomous services.
- **Agent-to-human *addressing*** (e.g. "A2H"-style proposals) — *discovering and reaching* a specific
  person across messaging channels. The problem is delivery: which human, on which channel, in a format
  they can act on.
- **MA2H** — the *coordination surface* a whole fleet shares with a human. Many agents converge on one
  hub; a human handles notifications, decisions, and tasks from one place; and each signed answer routes
  back to the originating (often already-exited) agent. (Despite the shared letters, MA2H is **not** the
  "A2H" above: the `A2H` in *MA2H* just spells the *agent → human* direction — the `2` is "to", as in M2M
  or B2B — and implies no dependency on, or implementation of, that addressing protocol.)

Reach for MA2H when the problem is **many agents, one human, one durable hub** — not wiring two agents
together, and not addressing a person. MA2H is the inbox and the decision loop, not the address book or
the agent-to-agent wire.

## Reuse of prior art

MA2H deliberately reuses conventions from established work so adopters are not learning a wholly new
vocabulary:

- **A2A** — message/part schema, `PushNotificationConfig` auth shapes, `contextId` grouping, task-state
  vocabulary.
- **HITL Protocol** (`rotorstar/hitl-protocol`) — the `202 Accepted` + `poll_url`/`review_url` handshake.
- **MCP elicitation** — `enum`/`enumNames` structured choices, `accept`/`decline`/`cancel` outcomes,
  flat schemas for renderability.
- **HumanLayer** — opaque `state` round-trip so stateless agents can resume; typed contact channels.
- **LangGraph** — `HumanInterruptConfig` permission flags.
- **CHEQ** (IETF draft) — keeping human-entered secrets out of the agent's LLM context.

See [`spec/v0.4.md` §11](spec/v0.4.md) for full provenance.

## Repository layout

```
README.md                          ← you are here
MIGRATION.md                       ← the rename to MA2H (A2H → AHCP → MA2H) + the v0.3 → v0.4 upgrade
CHANGELOG.md                       ← version history and migration notes
spec/v0.4.md                       ← the normative specification (current draft; adds the §13 inbound leg)
spec/v0.3.md                       ← superseded draft (kept for history)
spec/v0.2.md                       ← superseded draft (kept for history)
spec/v0.1.md                       ← superseded draft (kept for history)
schema/v0.4/
  message.schema.json              ← request leg (agent → Hub)
  response.schema.json             ← return leg (Hub → agent)
  inbound-message.schema.json      ← inbound leg (Hub → agent): the human→agent directive (v0.4)
  submit-ack.schema.json           ← 202 ack body
  get-message.schema.json          ← GET /v1/messages/{id} body
  capability.schema.json           ← GET /.well-known/ma2h discovery doc (+ the inbound capability)
examples/                          ← concrete envelopes (notify/ask/task + responses + directive + resume callback)
conformance/                       ← vector format, the verification classes, starter vectors
reference/                         ← @ma2h/reference — vendor-neutral TypeScript reference impl + `ma2h` CLI
plugins/ma2h-skills/                ← installable plugin: implement a Hub + build notify/ask/task skills
```

## Conformance

An implementation is conformant if it satisfies the normative requirements in `spec/v0.4.md` and the
proof obligations in `conformance/`. The `reference/` TypeScript implementation and the vectors in
`conformance/vectors/` define the interoperability baseline; the `ma2h` CLI can validate, sign, and
verify messages against the schemas.

## The name

**MA2H — Multi-agent to Human Protocol**, pronounced as **"mash."** The name works on three layers at once:

- **Topology** — *multi-agent → human*: many agents fan in to one human, the exact hub-and-spoke shape the
  protocol defines.
- **The problem** — it names what the protocol exists to solve: coordinating *many* agents with *a* human.
- **"Mash"** — one syllable, memorable, and apt: the hub *mashes together* — aggregates, reconciles, brings
  into one place — every agent's `notify`, `ask`, and `task`.

The `A2H` inside *MA2H* just spells the *agent → human* direction (the `2` is "to", as in M2M / B2B) — it is
**not** a reference to, or a dependency on, any similarly-named "A2H" addressing protocol. See
[when to use MA2H](#when-to-use-ma2h).

## Stewardship & governance

MA2H is stewarded by **Autonomy** and licensed [Apache-2.0](LICENSE). It is structured as a neutral,
donate-able standard rather than a single-vendor artifact, so that implementers can adopt it without
patent risk. Governance, the protocol-vs-product boundary, and the stated intent to transfer the
standard to a vendor-neutral foundation are documented in [GOVERNANCE.md](GOVERNANCE.md). Contribution
terms (DCO, spec-change process) are in [CONTRIBUTING.md](CONTRIBUTING.md).
