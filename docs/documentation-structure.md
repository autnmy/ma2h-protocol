# Suggested Documentation Structure (Advisory)

**Date:** 2026-06-20 · **Status:** advisory proposal — **no files are moved by this document.** It maps
the current repository into a mature, author-independent documentation structure and notes gaps, so AHCP
reads like a serious protocol-standards project to someone arriving with no prior context.

The guiding test: a reader finding this repository three years from now, with no access to the original
author, should be able to answer — *What is the problem? What is the protocol? Why does it exist? How do
I implement it?* — from the documents alone.

---

## Proposed information architecture

Ordered from "first contact" to "deep implementation":

| Layer | Purpose | Current home | Status |
|-------|---------|--------------|--------|
| **1. Landing / overview** | One-screen answer to "what is AHCP and why". | `README.md`, `index.html` | ✅ present (rebranded) |
| **2. Concepts / rationale** | The problem, the hub-and-spoke model, the three verbs, non-goals. | `README.md` (Overview, Problem, Hub, Non-goals) | ✅ present; could graduate to a dedicated `docs/concepts.md` if the README grows |
| **3. Normative specification** | The authoritative contract. | `spec/v0.3.md` (current), `spec/v0.2.md`, `spec/v0.1.md` (history) | ✅ present |
| **4. Schemas** | Machine-readable message/response/ack/capability schemas. | `schema/v0.3/…`, `schema/v0.2/…`, `schema/v0.1/…` | ✅ present |
| **5. Examples** | Concrete envelopes for every verb + responses + the resume callback. | `examples/` | ✅ present |
| **6. Conformance** | Vector format, verification classes, proof obligations. | `conformance/` | ✅ present |
| **7. Reference implementation** | Vendor-neutral implementation + `a2h` CLI. | `reference/` | ✅ present |
| **8. Adoption / integration** | How to implement a Hub or wire an agent (the plugin). | `plugins/a2h-skills/` | ✅ present |
| **9. Migration** | Version-to-version and naming changes. | `CHANGELOG.md`, `MIGRATION.md` | ✅ present |
| **10. Governance / contributing** | Stewardship, protocol-vs-product, spec-change process, license. | `GOVERNANCE.md`, `CONTRIBUTING.md`, `NOTICE`, `LICENSE` | ✅ present |
| **11. Working notes** | Internal plans, audits, advisory reviews. | `docs/plans/`, `docs/ahcp-rebrand-audit.md`, this file | ✅ present |

The repository already covers every layer. The recommendations below are refinements, not missing
pillars.

---

## Recommended file tree (target shape)

```
README.md                         ← landing + concepts (layers 1–2)
MIGRATION.md                      ← naming + version migration (layer 9)
CHANGELOG.md                      ← version history (layer 9)
GOVERNANCE.md  CONTRIBUTING.md  NOTICE  LICENSE   ← governance (layer 10)
spec/
  latest.md → v0.3.md             ← (proposed) stable "current" pointer
  v0.3.md  v0.2.md  v0.1.md
schema/  v0.3/  v0.2/  v0.1/
examples/
conformance/
reference/
plugins/a2h-skills/
docs/
  concepts.md                     ← (optional) if README's concepts outgrow it
  spec-improvement-recommendations.md
  documentation-structure.md      ← this file
  ahcp-rebrand-audit.md
  ROADMAP.md                      ← (proposed) non-normative roadmap moved out of spec §10
  plans/
```

---

## Gaps & recommendations

1. **A stable "current version" entry point.** Today the current spec is named by version
   (`spec/v0.3.md`), so every reference to "the current spec" must be hand-updated on each bump (the
   v0.2→v0.3 drift this rebrand corrected). Add a `spec/latest.md` (or a "Current: vX.Y" line in the
   README that all other surfaces link to) as the single source of truth for "what is current."
   (See `docs/spec-improvement-recommendations.md` R2.)

2. **A short "Implement a Hub in 10 minutes" quickstart.** The pieces exist (spec, schemas, reference,
   plugin), but there is no single guided path from zero to a conformant Hub. A `docs/quickstart.md` that
   walks: read §3–§9 → run the reference → grade against `conformance/vectors/` → install the plugin —
   would lower the adoption barrier and is purely additive.

3. **Non-normative roadmap.** Move the forward-looking roadmap out of `spec/v0.3.md` §10 into a
   `ROADMAP.md` so the spec stays purely normative. (See `docs/spec-improvement-recommendations.md` R3.)

4. **Concepts page (optional).** If the README's concept material (problem, hub model, verbs, non-goals)
   grows, graduate it into `docs/concepts.md` and keep the README as a concise landing page that links
   to it. Not needed at current size.

5. **Keep working notes clearly separated.** `docs/plans/`, the audit, and these advisory docs are
   useful institutional memory but are not protocol documentation. Their placement under `docs/` (not
   the repo root) already signals this; keep that boundary so the root stays protocol-first.

---

## Non-goals of this proposal

- It does **not** move or rename any existing file.
- It does **not** change the spec, schemas, or any wire surface.
- It is a target to converge toward incrementally, not a required reorganization.
