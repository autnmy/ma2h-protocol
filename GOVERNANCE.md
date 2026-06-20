# AHCP Governance

**Status:** Draft · **Steward:** Autonomy

## 1. Stewardship model

AHCP is currently **steward-governed** by Autonomy LLC. Autonomy maintains the spec, schema, and reference
implementation, and arbitrates changes. This is the initial phase, modeled on how MCP (Anthropic) and A2A
(Google) each began before moving to neutral foundations.

**Stated intent:** Autonomy LLC will transfer governance of AHCP to a vendor-neutral foundation once
adoption warrants. Candidate homes:

- The **W3C AI Agent Protocol Community Group** — royalty-free patent commitments via the W3C CLA/FSA.
- The **Linux Foundation / Agentic AI Foundation** (the directed fund that now houses MCP), via a
  Community Specification License project at the Joint Development Foundation.

This intent shapes day-to-day decisions: contributions and changes are accepted so that the spec stays
neutral and cleanly donate-able.

## 2. Protocol vs. product

AHCP (this repository) is an **open standard**. It is distinct from **the Hub** — Autonomy LLC's hosted
server and native triage application that *implement* AHCP. The Hub is a separate, proprietary commercial
product. Nothing in AHCP requires the Hub; any conformant implementation — open-source or commercial — is a
first-class citizen. Keeping these separate is intentional: the standard must be neutral to be adopted,
and the product competes on merit like any other implementation.

## 3. Licensing

- **Spec text, schema, and reference code:** Apache License 2.0 — chosen over MIT for its explicit patent grant.
- **Contributions:** accepted under the **Developer Certificate of Origin (DCO)**. Every commit must be
  signed off (`Signed-off-by: Name <email>`). This keeps provenance clean for a future foundation transfer.

## 4. Change process

Substantive changes follow a lightweight proposal flow — a **Spec Change Proposal (SCP)**, modeled on
MCP's SEP process and IETF Internet-Drafts:

1. Open an issue describing the problem and the proposed change.
2. Submit a PR against the spec **and** schema **and** at least one example.
3. Maintainers review for: backward compatibility; reuse of established conventions over invention;
   minimalism (does the *core* need this, or is it a binding/extension?); and security/privacy impact.
4. Breaking changes bump `a2h_version`.

## 5. Versioning

The protocol version is carried in every message as `a2h_version`. Before 1.0 the spec is a Draft and MAY
change incompatibly between minor versions. 1.0 marks the first stability commitment.

## 6. Maintainers

- **Autonomy LLC** (steward) — initial maintainer.

`MAINTAINERS.md`, `CODE_OF_CONDUCT.md`, and `ANTITRUST.md` will be added at the foundation-readiness stage;
the latter two are intake prerequisites for the Linux Foundation / JDF.
