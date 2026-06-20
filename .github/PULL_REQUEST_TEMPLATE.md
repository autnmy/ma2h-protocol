<!-- AHCP is a protocol spec. Editorial fixes and non-breaking clarifications can be opened directly with
     this template. Breaking changes, new features, or governance changes need a Spec Change Proposal
     (SCP) first — see CONTRIBUTING.md. -->

## Change type
<!-- Check all that apply. -->
- [ ] Editorial — spelling, formatting, links, examples; no change to observable behavior
- [ ] Normative — non-breaking — new optional behavior, or a clarification that surfaces an existing contract
- [ ] Normative — breaking — removes/tightens a MUST/SHOULD, or changes a schema `$id` / version path (requires a merged SCP)
- [ ] Process / governance / tooling

## Description
<!-- One paragraph: what changes and why. -->

## Motivation
<!-- The problem this solves. Link the issue or SCP if any: Closes #NNN -->

## Backward compatibility
<!-- REQUIRED for normative changes. Describe incompatibilities and the migration path, and state
     whether any schema `$id` / version path changes. For editorial PRs, write "N/A — editorial". -->

## Security considerations
<!-- REQUIRED. Does this change introduce, modify, or close any attack surface? Consider:
     authentication/authorization, input-validation surface, data exposure (PII / sensitive fields),
     replay/injection, trust-boundary changes. If security-neutral, say so and why in one line.
     Per IETF RFC 3552, a blank "no security considerations" is rarely credible and will block merge. -->

## Conformance & reference implementation
- [ ] No conformance vectors affected
- [ ] Updated/added vectors in `conformance/vectors/` (list them)
- [ ] Reference implementation updated in `reference/` and `npm test` passes

## Checklist
- [ ] BCP 14 (RFC 2119 / 8174) keywords used correctly; boilerplate already present in the spec
- [ ] Schema `$id` / version path updated **only** if this is a breaking change; otherwise unchanged
- [ ] `CHANGELOG.md` entry added under the right heading
- [ ] All commits are signed off — `Signed-off-by: Name <email>` (DCO; `git commit -s`)
- [ ] Scoped to one logical change (or a follow-up issue is filed for the rest)
