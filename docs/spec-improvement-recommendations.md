# Spec Improvement Recommendations (Advisory)

> **Archived (2026-08-15).** This review targets `spec/v0.3.md`, two versions behind the current
> v0.5; several of its items have since been addressed in the v0.4/v0.5 revisions. Retained for
> history — do not work from it. A fresh advisory pass, if wanted, should target the current spec.

**Date:** 2026-06-20 · **Target:** `spec/v0.3.md` · **Status:** advisory — **none of these are applied
here.** This document reviews the specification for ambiguities, inconsistencies, terminology drift, and
clarity opportunities. Per the rebrand's constraints, **no protocol semantics, message shapes, or
version are changed.** Every recommendation below is a clarity/organization suggestion for a future spec
revision, and any item that *would* touch wire behavior is explicitly flagged as out-of-scope for a
naming-only change.

The spec is already in good shape: §1 cleanly disambiguates the three historically-overloaded terms
(`status` / `resolution` / `state`), conformance is defined for both Hub and Agent, and RFC 2119
keywords are used throughout. The items below are refinements, not corrections.

---

## R1 — Document that the `ma2h` wire identifiers are frozen going forward (highest value)

**Observation.** The protocol identity is now uniformly `ma2h` — the `a2h` slug was fully retired in the
pre-1.0 rename (see `MIGRATION.md`), so the earlier brand↔slug *split* this section once flagged no longer
exists. What remains worth protecting is the same hazard in the new identity: a future "consistency
cleanup" could rename a wire identifier (`ma2h_version`, the `MA2H-Signature` header, `MA2H_CALLBACK_SECRET`,
`/.well-known/ma2h`, `x-ma2h-sensitive`) or the schema `$id` host and **unknowingly ship a breaking
change** — changing the signed bytes / discovery path / field name and breaking every implementation and
conformance vector.

**Recommendation.** Add a single non-normative note near §1 or §10:

> *Frozen identifiers: the wire identifiers — `ma2h_version`, the `MA2H-Signature` header,
> `MA2H_CALLBACK_SECRET`, `/.well-known/ma2h`, `x-ma2h-sensitive` — and the schema `$id` host
> `ma2h.org` are part of the interoperability contract and MUST NOT be renamed without a major
> version bump.*

This is a clarity addition (no wire change). The CI `scripts/check-frozen-identifiers.sh` guard already
enforces it mechanically; mirroring it in the spec protects the normative source directly. **Recommended
for the next spec touch.**

---

## R2 — Keep a single canonical "current version" pointer

**Observation.** Before this rebrand the README header, the repo-layout block, and the website each
advertised **v0.2** as current, while `spec/v0.3.md` and the CHANGELOG had moved to **v0.3** — a drift
that misleads a newcomer about which spec is normative. The rebrand corrects the pointers, but nothing
structurally prevents recurrence.

**Recommendation.** Establish one authoritative "current version" signal that other surfaces reference
rather than restate — e.g. a `spec/latest.md` that points to the current draft, or a single "Current:
vX.Y" line in the README that the website and sub-docs link to. Reduces the number of places a version
bump must be hand-updated. (Documentation-structure concern; see `docs/documentation-structure.md`.)

---

## R3 — Move the forward-looking roadmap out of the normative spec

**Observation.** §10 ends with **"Roadmap (out of v0.3): human SSO mechanics; assignment/escalation/SLA
(v0.4); multi-turn threads; streaming; channel fan-out."** This is non-normative, speculative content
inside an otherwise normative document; it can age poorly and blur the line between what is specified
and what is merely intended.

**Recommendation.** Relocate the roadmap to a separate non-normative `ROADMAP.md` (or a clearly-labeled
"Non-normative" appendix), leaving §10 to cover only versioning rules. Clarity/organization only; no
normative change.

---

## R4 — Standardize "verb" vs "message type"

**Observation.** §5 is titled "The Three Verbs" and consistently calls `notify`/`ask`/`task` *verbs*,
but §1 refers once to a message "type/kind", and schemas express the same concept via a discriminator
field. The variance is minor but invites drift as the spec grows.

**Recommendation.** Pick one term ("verb" reads well and is already dominant) and use it everywhere the
prose refers to the `notify`/`ask`/`task` distinction; reserve "type"/"kind" for the schema-level
discriminator only. Prose-only; no wire change.

---

## R5 — Reinforce the `Caller` routing tuple where responses are described

**Observation.** §1 defines **Caller** as `(agent.id, agent.run_id)` and states "Responses route to the
Caller." Later sections (§6 Response, §8.3 Push) describe response delivery without always restating that
the Caller tuple — not merely `agent.id` — is the routing key. A reader skimming §8.3 alone could
under-specify routing for a fleet where one `agent.id` has many concurrent runs.

**Recommendation.** Add a one-clause cross-reference in §6/§8.3 ("…to the originating Caller
`(agent.id, agent.run_id)`, see §1") so the routing key is unambiguous at the point of use. Clarity
cross-reference only.

---

## R6 — Make the schema `$id` ↔ path relationship explicit in the spec

**Observation.** Schemas are served from `schema/vX.Y/…` but carry `$id`s on `ma2h.org`.
`CONTRIBUTING.md` documents the freeze rule (a non-breaking change keeps the existing `$id`); the spec
itself does not restate where the canonical schema lives or how `$id` relates to the served path.

**Recommendation.** Add a sentence in §8 (or an appendix) noting the canonical `$id` host and that the
served path mirrors it per version. Helps implementers dereferencing schemas. Documentation only.

---

## Summary

| ID | Theme | Type | Applies here? |
|----|-------|------|---------------|
| R1 | Brand↔slug freeze note | clarity addition | No — next spec revision |
| R2 | Single current-version pointer | doc structure | No — see doc-structure proposal |
| R3 | Roadmap out of normative spec | organization | No — next spec revision |
| R4 | "verb" vs "type" consistency | terminology | No — next spec revision |
| R5 | Caller tuple cross-reference | clarity | No — next spec revision |
| R6 | `$id` ↔ path note | documentation | No — next spec revision |

None of these require a version bump; none change the wire format. They are recorded so a future
maintainer can improve the spec's clarity without re-discovering the same observations.
