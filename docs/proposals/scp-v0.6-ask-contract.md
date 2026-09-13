# SCP: MA2H v0.6 — the `ask` contract (answerability, option uniqueness, `allow_edit`)

> Drafted in-session against a conformant Hub's production data. Sponsored by the steward.

## Preamble
- **Author(s):** Tim Layton (drafted with Claude)
- **Status:** Proposed — shipped as spec v0.6 (2026-09-13)
- **Type:** Standards Track (normative)
- **Created:** 2026-09-13
- **Scope:** §5.2 (the `ask` request block), §6 (the Response `detail`), §8.8 (resolve validation), §9.6 (untrusted content). No other section is touched.

## Abstract

v0.6 is the first **corrective** release in MA2H's history. Every version before it extended the
protocol outward — v0.2 hardening, the v0.3 payload-bound signature, the v0.4 inbound leg, the v0.5
inter-agent leg — each additive by construction. v0.6 turns inward and repairs the `ask` contract:
the oldest surface in the protocol, and the one every other leg now routes answers through.

Four defects, one cluster. Two are mistakes that let a Hub accept an ask no human could answer or
whose answer was ambiguous. Two are fields that shipped on the wire, in both schemas, and (for one of
them) inside the §9.2 signature, with no normative text in any version.

## Motivation

The four were found together while auditing a production Hub, and they share a shape: **each fails
silently, and each fails toward the human**, who cannot fix any of them, and away from the agent, who
can.

### 1. `request.schema` constrained the container, not the contract

`message.schema.json` typed it `{"type": "object"}` — which says only *this field is a JSON object*,
never that the schema **describes** one. §6 fixes the `input` answer as an object validating against
`schema`. So `{"type": "string", "minLength": 1}` was wire-valid and admitted no possible answer.

Not hypothetical. One such ask was found in a production inbox of 1,578 messages. It rendered with no
input fields (a renderer walks `schema.properties`; there were none), the human could not answer it,
and the agent never learned why. It was discovered only by auditing stored envelopes by hand.

### 2. `options[].value` had no uniqueness constraint

§6 returns the chosen `value` and **nothing identifying which entry produced it**. Two options sharing
a `value` therefore make the Response ambiguous at the protocol level — unrecoverable at either end,
because the distinguishing information was never on the wire.

The cost was already being paid downstream: conformant clients tracked the human's selection by array
**index** rather than by value, carrying defensive comments explaining that the protocol would not
promise uniqueness. The protocol pushed its own ambiguity onto every implementer.

### 3. `allow_edit` / `edited` were a half-finished design

Both in `message.schema.json` and `response.schema.json`. `edited` already bound into the §9.2
signature. Neither with a line of normative text or even a schema `description`, in objects where
every neighbouring field had both.

And the thing they reach for is a real, frequent gap: **a `select` whose options do not fit.** The
agent asks "ship, hold, or roll back?" and the true answer is "hold, but only until the migration
lands". Before v0.6 the human's only exits were to pick a wrong option — silently corrupting the
agent's input — or `decline`, which carries no `value` and discards the decision.

### 4. `allow_accept` was undefined in every version

Same story, no Response-side anchor, no implementation, never referenced outside an example block.

## Normative changes

Summarized here; the authoritative text is [spec/v0.6.md](../../spec/v0.6.md) §5.2, §6, §8.8, §9.6,
and the release notes in [CHANGELOG.md](../../CHANGELOG.md).

1. **`options[].value` MUST be unique** within `options`. Hub-enforced (`422`), because JSON Schema
   has no uniqueness-by-sub-property keyword. `label`/`description` stay unconstrained.
2. **`request.schema` (mode=input) MUST describe the answer object** — ≥1 `properties` entry, and
   any declared `type` must ADMIT an object (the string, or a well-formed array containing it).
   Rejected `422 invalid_field` at submit.
3. **`allow_edit` defined**: permits an off-menu `value` on `select`/`confirm`. Default `false`.
   **`edited` defined**: `true` iff `value` ∉ `options[].value`, Hub-computed from the answer.
4. **`allow_accept` removed** from the spec surface; behaviorally inert under §10 robustness.

## Key design decisions

### KTD1 — `edited` is derived from SET MEMBERSHIP, not human intent

The alternative was "true iff the human used the free-form affordance". Rejected. Set membership makes
`edited` a **property of the answer** rather than of the UI: independently recomputable by the agent
from `request.options` + `value`, so an agent **verifies** it instead of trusting a Hub; deterministic,
so two resolutions with the same value against the same options always agree; and impossible for a Hub
to get subtly wrong by mistracking UI state. A human who types `hold` by hand into a free-form box
still chose a listed option, and the protocol says so.

Consequence accepted deliberately: membership is exact string equality, so `Ship` and `ship ` are
off-menu. Coercing a near-miss would fabricate a choice the human did not make — the exact failure the
flag exists to surface.

### KTD2 — reject at SUBMIT, not at resolve

The rule the whole release follows. A submit-time `422` reports the defect to the **agent**, the only
party that can fix a bad schema or a duplicate option. A resolve-time failure reports it only to the
**human**, who can do neither and has no channel to say what is wrong — and leaves the ask stranded
`open` forever. That asymmetry is what made all four defects silent.

### KTD3 — two version questions with different answers

An earlier revision of this record said "`allow_edit` gets no version gate", which conflated two
questions that must be answered separately.

**What must a sender DECLARE to use it?** `"ma2h_version": "0.6"`. `allow_edit` is v0.6 vocabulary, a
Hub honors it only at minor ≥ 6, and `wireVersionFor` therefore lifts an ask that sets it. An ask
declaring 0.5 while setting the field has contradicted itself and is resolved against its declared
version.

**What happens when the HUB is older than the sender?** Nothing breaks, and no feature detection is
needed: a pre-0.6 Hub treats it as an unknown field (§10), enforces membership, and returns a listed
value with `edited` absent — which is *true*. The agent is not lied to, merely un-helped.

Contrast `to` (§4), where both answers coincide because acting on the field and ignoring it produce
materially different **deliveries**, so a sender there must feature-detect. Here the un-helped
outcome is still a correct outcome, which is why the second answer is safe even though the first is
a hard requirement.

### KTD4 — `allow_edit` is finished, `allow_accept` is removed

Two undefined fields, opposite dispositions, and the asymmetry is principled. `edited` is already
inside the §9.2 signature, so deleting that pair is a signature break — and the gap it leaves is real
and would return. `allow_accept` has no Response-side anchor, so nothing can depend on it, and
inventing a meaning would add core surface for a need nobody has stated (governance §4.3 minimalism).

### KTD5 — the removal is spec-surface only

`permissions` deliberately keeps no `additionalProperties: false`. Rejecting a pre-0.6 sender's
`allow_accept` would be gratuitous breakage: the field never had semantics, so no sender ever meant
anything by it. §10 robustness already covers the case. Pinned by `sv-073`.

### KTD6 — `sv-071` is deliberately a VALID vector

It submits the exact shape a Hub must reject (two options, one value, different labels) and asserts
the **schema accepts it** — because `uniqueItems` cannot see the collision. The boundary of the
schema's reach is recorded inside the vector set, so a green run is never mistaken for proof that
uniqueness is enforced. The rule lives in `dp-026`.

## Alternatives considered

- **Tell agents to read `comment` instead of defining `allow_edit`.** Rejected: `comment` annotates a
  *chosen option*. `value` stays wrong, the agent has no signal to look elsewhere, and it still
  believes the human picked what they were forced to pick. It makes the silent failure more likely.
- **A fourth mode (`select-or-input`).** Rejected: more surface for the same outcome, strands two
  fields already on the wire, and mode is the wrong axis — this is a *permission* on an existing mode,
  which is what `permissions` is for.
- **Delete `allow_edit` and `edited`.** Rejected per KTD4 (signature break, and the gap returns).
- **Amend v0.5 in place.** Rejected: v0.5 is published, on the public site, and vendored downstream at
  a commit pin. Two of the four changes narrow what a Hub accepts, and GOVERNANCE §4.4 requires a
  version bump for that. Amending a shipped version to be stricter is exactly what a version number
  exists to prevent.
- **Express uniqueness in JSON Schema.** Not possible in 2020-12; see KTD6.

## Security and privacy

One change in kind, and it drives a normative obligation. An off-menu `value` is **human free text**,
where every `value` before it was a string the agent itself authored and could treat as known-safe. An
agent setting `allow_edit` MUST treat it as untrusted, as it would `body` or `comment` — §9.6 now says
so alongside them. `edited` is signature-bound, so the signal telling an agent *which* answers need
that care cannot be stripped in transit.

No new data leaves a Hub that `comment` does not already carry.

## Conformance

Schema-validation `sv-067..074`; downstream proof `dp-026`, `dp-027`, `dp-028`. Worked examples
[`ask-select-allow-edit.json`](../../examples/ask-select-allow-edit.json) and
[`response-edited-answer.json`](../../examples/response-edited-answer.json). The reference exports
`duplicateOptionValue`, `unanswerableInputSchema`, `isEditedAnswer` so implementations discharge the
class-3 obligations against its reading rather than a re-derived one. See the
[v0.6 coverage map](../../conformance/README.md#v06-coverage-map--the-ask-contract).

## Open questions

1. `select` currently requires `options` with `minItems: 1`. A one-option select is odd but not
   broken, and downstream tooling already requires two. Worth tightening to 2 in a later release?
2. Should a Hub *advertise* `allow_edit` support in the §8.0 capability document? KTD3 argues it is
   unnecessary (the degradation is safe and honest), but an agent that genuinely depends on free-form
   answers currently has only `ma2h_version` to read.
