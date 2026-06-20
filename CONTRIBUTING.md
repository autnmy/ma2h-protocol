# Contributing to AHCP

Thanks for helping improve the Agent Human Coordination Protocol. AHCP is a specification — a Markdown spec
(`spec/`), JSON Schemas (`schema/`), conformance vectors (`conformance/`), and a TypeScript reference
implementation (`reference/`). This guide covers how changes are proposed and merged.

AHCP is **steward-governed** today (see [GOVERNANCE.md](GOVERNANCE.md)), with the stated intent to move to
a vendor-neutral foundation. The process below is deliberately lightweight but mirrors the conventions of
MCP (SEP), Rust (RFC), Python (PEP), IETF, and the OpenAPI / JSON Schema / CloudEvents communities, so it
scales as governance opens up.

## Two paths

**1. Open a Pull Request directly** — for:
- Editorial changes (spelling, formatting, links, added examples — no change to observable behavior).
- Non-breaking normative clarifications (surfacing an existing contract; tightening prose without changing
  what a conforming implementation does).
- Conformance-vector or reference-implementation fixes that don't change spec text.

Use the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).

**2. File a Spec Change Proposal (SCP) first** — for:
- Breaking changes (removing/retightening a MUST/SHOULD; changing a schema `$id` or version path).
- New features or message types.
- Governance or process changes.
- Anything likely to have multiple valid designs or to generate debate.

Open an [SCP issue](.github/ISSUE_TEMPLATE/spec-change-proposal.md), get a steward to sponsor it, then open
the implementation PR linked to the SCP. (Modeled on the MCP SEP and Rust RFC processes.)

### Editorial vs. normative

A change is **normative / substantive** — and needs the SCP care above — if any of these hold (the W3C /
JSON Schema test):

| | Editorial | Normative |
|---|:---:|:---:|
| Spelling, grammar, formatting, links | ✓ | |
| Adds examples, no new keywords | ✓ | |
| Clarifies without changing observable behavior | ✓ | |
| Changes any MUST / MUST NOT / SHOULD / SHOULD NOT / MAY | | ✓ |
| Adds/removes a schema property or changes a type | | ✓ |
| Changes a schema `$id` or version path | | ✓ |
| Would make a conforming implementation behave differently | | ✓ |
| Would require a prior reviewer to re-review | | ✓ |

Non-breaking normative clarifications still go through a **direct PR** — the SCP track is for breaking,
feature, or governance changes.

## Versioning & backward compatibility

AHCP versions the spec with SemVer intent:
- **PATCH** — editorial only.
- **MINOR** — backward-compatible additions (new optional fields, new SHOULD/MAY, a new schema version path).
- **MAJOR** — breaking changes.

**Schema `$id` discipline.** Each published schema version has an immutable `$id`
(`https://ahcpprotocol.org/schema/vX.Y/...`). A **non-breaking** change keeps the existing `$id` / path; a
**breaking** change mints a new version path (and only lands via a merged SCP). Every PR declares whether
the `$id` / version path changes.

## Normative language

Use BCP 14 ([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) + [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174))
keywords — MUST, SHOULD, MAY, etc. The boilerplate is already in the spec; use uppercase keywords only where
the normative meaning is intended.

## Security considerations

Every PR and SCP states its security impact. Per [IETF RFC 3552](https://www.rfc-editor.org/rfc/rfc3552),
a credible "no security considerations" is rare for protocol work — if a change is security-neutral, say so
and why. Reviewers will return a PR whose security section is blank.

## Conformance & the reference implementation

A normative change that alters observable behavior **MUST** add or update vectors in `conformance/vectors/`
and keep the reference implementation (`reference/`) in sync — `npm test` in `reference/` must pass.
Editorial changes and added examples may skip this. (Adapted from MCP SEP-2484's conformance gate.)

## Sign-off (DCO)

AHCP uses the [Developer Certificate of Origin](https://developercertificate.org) — not a CLA. Sign off every
commit:

```
git commit -s -m "..."
```

which appends `Signed-off-by: Your Name <you@example.com>`. By signing off, you certify the DCO.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:` …) and
keep each PR scoped to one logical change.
