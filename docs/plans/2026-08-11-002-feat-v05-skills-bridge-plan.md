---
title: "feat: ma2h-skills teach the v0.5 leg + new build-bridge skill"
date: 2026-08-11
type: feat
origin: "issue #28 (scope) · spec/v0.5.md (authority) · reference/src/agent.ts runBridgeLoop (the worked bridge pattern)"
depth: standard
---

# feat: ma2h-skills teach the v0.5 leg + new build-bridge skill (issue #28)

**Target repo:** `autnmy/ma2h-protocol` (worktree branch `28-skills-v05-bridge`).

## Summary

Teach the merged v0.5 inter-agent leg through the `ma2h-skills` plugin: update the five existing
skills (`implement`, `build-notify`, `build-ask`, `build-task`, `build-inbox`) to the v0.5 surface
and add a **new `build-bridge` skill** that scaffolds an app-specific always-on inbox bridge
mirroring `reference/src/agent.ts` `runBridgeLoop`. Docs-only change (markdown under
`plugins/ma2h-skills/` + this plan). The one hard rule, from the issue's acceptance criteria: **every
endpoint, error code, and duty written into a skill must exist in `spec/v0.5.md`** — no invented
surface — and the bridge scaffold must provably surface (never swallow) fatal failures.

---

## Problem Frame

Prerequisites #25 (spec+schemas), #27 (vectors), #26 (reference incl. the bridge worked example) are
merged; `main` @ `d22898b`. The plugin still teaches v0.4: an implementer following the skills today
builds a Hub with no sessions, no addressed routing, no delivery honesty, and an agent with no way to
run the reliable-bridge pattern the reference now demonstrates. Issue #28 closes that gap — it is the
last ma2h-side piece of the SCP #24 inter-agent body of work.

## Requirements (from issue #28)

- R1 `implement`: §2 endpoint table gains sessions (`POST/GET/DELETE /v1/sessions`), the `?session=`
  drain, optional `inbound.stream_url` + `stream_max_hold_seconds`; §3 checklist gains submit-time
  destination validation (+ allowlist-block collapse to `422 unknown_destination`),
  bounce/truthfulness rules (`expired` ⇒ never delivered; bounce covers un-acked incl.
  drained-but-unacked with receipt `prior`), addressee-default resolvers, `queued`-not-`delivered`
  addressed acks, the three §9.8 entry signing duties, zombie-socket/lease rules, account opt-in
  default (`inter_agent.enabled` false).
- R2 `build-notify` / `build-ask` / `build-task`: optional `to` addressing, capability-gated on
  `inter_agent`, the ack `destination` misroute detector (addressed ack without `destination` ⇒
  pre-0.5 misroute), reachability-snapshot handling.
- R3 **new `build-bridge`**: scaffold an always-on bridge mirroring the reference loop —
  registration → drain/stream (reconnect-as-renewal) → §13.4 verify order (incl. session-qualified
  addressee check) → explicit declared sender policy (never implicit) → act (§8.8 resolve) → ack
  after durable processing → close; supervision guidance (restart-on-exit, backoff+jitter, DISTINCT
  fatal exit codes, never-silent rule); hub-side reachability truth as the backstop.
- R4 `build-inbox`: route through the session-scoped drain; keep the v0.4 session-less path
  documented for pre-0.5 hubs.
- R5 Follow the existing skills' structure/tone exactly; keep frontmatter conventions (the
  `scripts/check-skill-frontmatter.rb` CI gate).
- R6 Acceptance: a fresh implementer following only the skills produces a Hub/agent pair that passes
  the v0.5 vectors; the bridge scaffold provably surfaces fatal failures; zero spec-vs-skill
  mismatches.

## Key Technical Decisions

- **Spec-exactness over completeness.** Skills are load-bearing maps, not spec restatements (the
  `implement` skill says so itself). Each added item cites its spec section and states the wire-exact
  codes (`422 unknown_destination`, `410 destination_gone`, `404` foreign/unknown drain, `429`
  over-cap) — but the linked spec + vectors stay the contract.
- **Version references move 0.4 → 0.5 across all six skills** (spec/schema URLs, `ma2h_version` in
  templates). v0.5 is additive; the current spec is the one to teach. Addressed sends REQUIRE
  minor ≥ 5 (sv-vectors: version-gated addressing), so templates that gain `to` must send `"0.5"`.
- **`implement` keeps its shape**: v0.5 rows join the §2 table marked *(v0.5, optional)*; the
  cross-cutting v0.5 Hub MUSTs join §3 as a clearly-labeled v0.5 block (per the issue's explicit
  placement) with a pointer note that they bind only a Hub offering `sessions`/`inter_agent`; a new
  short §6b-style section covers the optional inter-agent leg the way §6 covers the inbound leg.
- **`build-bridge` mirrors the builder-skill formula** (gather config → generate skill + helper →
  verify → hand off → optional plugin packaging) and points the generated helper at
  `runBridgeLoop`/`receiveEntry` in the reference — same move `build-inbox` makes with
  `receiveDirective`. Exit codes 2/3/4 and the loud-failure classification are taught as the
  contract; supervision guidance (restart-on-exit, backoff+jitter, never-silent) frames the §14.2
  bounce rules as the Hub-side backstop when the client dies anyway.
- **`build-inbox` teaches drain modes, not a rewrite**: session-scoped drain (`?session=`) is the
  v0.5 path (required to see `message`/`response`/`receipt` entries); the v0.4 session-less drain
  stays documented as the pre-0.5/pre-sessions fallback returning exactly the v0.4 shape.
- **Plugin README updated in the same change** — its skills table enumerates the skills; adding
  `build-bridge` without listing it ships stale docs.

## Implementation Units

### U1. `implement` skill — the v0.5 Hub surface

**Goal:** A Hub implementer sees the complete v0.5 surface: sessions endpoints, session-scoped
drain + stream, the §8.8 resolve binding for agent resolvers, and every v0.5 Hub MUST.
**Requirements:** R1, R5, R6.
**Files:** `plugins/ma2h-skills/skills/implement/SKILL.md`.
**Approach:** §0/References → v0.5 URLs (+ `session.schema.json`, `resolve-request.schema.json`,
`examples/entry-signatures-v0.5.md`). §2 table adds *(v0.5, optional)* rows: `POST/GET/DELETE
/v1/sessions`, `GET /v1/inbox?session=`, `POST /v1/inbox/ack?session=`, optional SSE
`inbound.stream_url`; the existing resolve row notes it is now the pinned §8.8 wire binding
(agent resolvers, `?session=` presentation). §3 gains a labeled v0.5 checklist block: submit-time
destination validation (`422 unknown_destination` / `410 destination_gone`; cross-account
indistinguishable; visibility collapse; allowlist-block collapse; retroactive to directive `to`),
addressed-ack honesty (`queued` never `delivered` for notify; `open` for ask/task; REQUIRED
`destination` snapshot, `{"state":"unknown"}` without visibility), delivery honesty (`expired` ⇒
never delivered; bounce covers un-acked session-addressed command mail incl. drained-but-unacked,
receipt `prior` `queued`/`delivered`; principal-addressed retention orphan; `system:undeliverable`
auto-resolutions; response/receipt entries never bounce), addressee-default resolvers (+
session-qualified matching; human NOT a default; kill-switch), the three §9.8 entry signing duties
(contexts + digests + per-delivery re-signing + strip rule + ack keys/id namespaces),
zombie-socket/lease rules (client-originated renewal only; bounded stream holds ≤ freshness, margin
before lease expiry; stream delivery provisional), account opt-in (`inter_agent.enabled` default
false; `inter_agent` requires `ack`), durability additions (§3.1: entries, leases, bounce
obligations). New short section for the optional inter-agent leg (mirrors §6's framing) + §7/§8
handoff lines mention `build-bridge`.
**Test scenarios:** none (docs) — verification is the U6 spec-fidelity audit + CI frontmatter gate.
**Verification:** every claim traceable to a `spec/v0.5.md` section; `ruby
scripts/check-skill-frontmatter.rb` passes.

### U2. Sender skills — optional `to` addressing (`build-notify`, `build-ask`, `build-task`)

**Goal:** Generated sender skills can address another agent of the same account, honestly.
**Requirements:** R2, R5, R6.
**Files:** `plugins/ma2h-skills/skills/build-notify/SKILL.md`,
`plugins/ma2h-skills/skills/build-ask/SKILL.md`, `plugins/ma2h-skills/skills/build-task/SKILL.md`.
**Approach:** Templates bump to `ma2h_version: "0.5"` + v0.5 URLs. Each gains a compact *(optional,
v0.5)* "Address it to another agent" block: `to` grammar (`agent:<id>` / `agent:<id>#<sess>`);
feature-detect `inter_agent.enabled` via §8.0 BEFORE using `to` (account-opt-in, default false);
submit-time rejections the sender must expect (`422 unknown_destination` — incl. cross-account,
allowlist-block, visibility collapse; `410 destination_gone`); the ack differences — notify acks
`queued` never `delivered` (delivery track `queued→delivered|bounced|expired`), ask/task ack `open`;
REQUIRED `destination` reachability snapshot handling (`online`/`offline`/`unknown`, exact
`{"state":"unknown"}` without visibility); the **misroute detector** (ack without `destination` ⇒
pre-0.5 Hub misrouted to the human inbox — surface the failure; SHOULD cancel a misrouted ask via
§8.4); addressed ask/task resolver default flips to the **addressee** (list `human:<id>` explicitly
to keep a human resolver); `agent.session` on submits (session-qualified `from`, `response`-entry
return leg for a live session, exclusion from idempotency comparison); undeliverable
auto-resolution the sender will read back (`cancelled`/`dismissed` by `system:undeliverable`).
notify-specific: addressed notify is durable-but-bounceable, check `mailbox` on the ack's
`poll_url`. ask/task-specific: response arrives as a signed `response` entry when session-registered
(dedup on `(in_reply_to, resolution_id)` unchanged) — point at `build-bridge` for the draining side.
**Test scenarios:** none (docs) — U6 audit.
**Verification:** claims traceable to §4, §5.1, §8.0, §8.1, §8.5, §6, §7, §9.1; frontmatter gate.

### U3. NEW `build-bridge` skill

**Goal:** A builder skill that scaffolds an app-specific always-on inbox bridge which a fresh
implementer can run supervised, and which provably surfaces fatal failures.
**Requirements:** R3, R5, R6.
**Files:** `plugins/ma2h-skills/skills/build-bridge/SKILL.md` (new).
**Approach:** Builder formula (gather → generate skill + loop helper → verify → hand off → optional
plugin packaging). Gather: hub URL + `sessions`/`inter_agent`/`inbound` capability check, agent
identity, verification key, **explicit sender policy (MUST be declared — allowlist or deliberate
`any-same-account`; never implicit)**, supervisor choice (systemd/launchd/container/PM2), decide
step (what the app does with a verified ask/task). Generated loop = the reference lifecycle:
register (§16.1, TTL clamp, over-cap 429) → drain `?session=` (or stream; reconnect-as-renewal,
§16.2; merely-open socket is NOT liveness) → per entry §13.4 order: verify §9.8 signature
(recompute digest, `t` window, `jti` cache) + shape-validate/strip → addressee check incl.
**session-qualified** (own CURRENT session; prior-session entries refused) → declared-policy check →
act (resolve via §8.8 `?session=`, expect `409 already_terminal` race as normal) → dedup
reserve/commit → ack presenting the session after durable processing → close session on orderly
exit (§16.3). Failure discipline table: exit 2 auth (§9.1 rejections), exit 3 own-session-terminal
`410` (lease lapsed/kill-switched → supervisor restarts → re-register; distinct from foreign/unknown
`404`), exit 4 signature/shape verification failure (possible tampering — page a human, do NOT
restart-loop past it); anything else propagates loud; **never** exit 0 having swallowed a failure;
no silent `catch`-continue. Supervision: restart-on-exit + backoff+jitter, treat exit codes
distinctly, log to a surface someone reads. Backstop framing: when the bridge dies anyway, the Hub's
§14.2/§15 machinery tells senders the truth (lease lapses → bounce + `system:undeliverable`
auto-resolutions; reachability stops reading `online`) — the bridge's job is to be honest-by-exit,
the Hub's job is honesty-about-the-bridge. Point at `runBridgeLoop` + `bridge.test.ts` as the
port-me example (as `build-inbox` points at `receiveDirective`).
**Test scenarios:** none (docs) — U6 audit; the generated-skill smoke test teaches: send an
addressed test ask from a second identity, watch the bridge resolve it, kill the session
(kill-switch) and observe exit 3 + supervisor restart + re-register.
**Verification:** loop steps map 1:1 to `runBridgeLoop`; exit codes match
`EXIT_AUTH_FAILURE=2` / `EXIT_SESSION_TERMINAL=3` / `EXIT_SIGNATURE_FAILURE=4`; every duty cites
§8.7.1/§8.8/§9.8/§13.4/§14.2/§15.1/§16; frontmatter gate.

### U4. `build-inbox` — session-scoped drain

**Goal:** The inbox skill routes through the session-scoped drain on v0.5 hubs and still serves
pre-0.5 hubs.
**Requirements:** R4, R5, R6.
**Files:** `plugins/ma2h-skills/skills/build-inbox/SKILL.md`.
**Approach:** v0.5 URLs. Config gathering adds: `inbound.session_param` / `sessions` capability
check → **session-scoped mode** (register → drain `?session=` → ack `?session=` → close): required
to receive the v0.5 entry kinds, renews lease/presence; drain errors pinned (`404`
foreign/unknown, `410` own-terminal ⇒ re-register). Session-less v0.4 drain stays the documented
fallback (pre-0.5 Hub or directives-only agent) returning exactly the v0.4 shape — and note the
§15.1 split: a session-less-only consumer never reads `online` for addressed-message reachability.
Duties section points at §13.4's two v0.5 amendments (session-qualified addressee check; declared
policy) and at `build-bridge` for the always-on pattern; entry-kind ack keys noted (`message`→`id`,
`response`→`resolution_id`, `receipt`→`id`). Template gains the `?session=` variant + register/close
curl lines.
**Test scenarios:** none (docs) — U6 audit.
**Verification:** claims traceable to §8.7/§8.7.1/§13.4/§15.1/§16; frontmatter gate.

### U5. Plugin README — table + v0.5 framing

**Goal:** The plugin's own docs list the new skill and the v0.5 leg.
**Requirements:** R5.
**Files:** `plugins/ma2h-skills/README.md`.
**Approach:** Skills table gains the `build-bridge` row (direction: **agent ↔ agent**); intro
sentence extends "as of v0.4 … directive" with the v0.5 inter-agent leg; typical-flow gains the
bridge step. Minimal diff.
**Test scenarios:** none (docs).
**Verification:** table lists six skills; no stale v0.4-only framing.

### U6. Spec-fidelity audit (the acceptance gate)

**Goal:** Zero spec-vs-skill mismatches — the issue's hard acceptance criterion.
**Requirements:** R6. **Dependencies:** U1–U5.
**Files:** none (review pass over the five changed + one new SKILL.md against `spec/v0.5.md`).
**Approach:** For each skill, extract every endpoint, error code, capability field, signed-context
field list, id namespace, and duty it asserts; grep-confirm each exists in `spec/v0.5.md` (or the
reference for the exit codes). Particular traps to re-check: `queued` vs `delivered` on addressed
notify acks; `422` vs `410` vs `404` per touchpoint (the §16.3 table); receipt `prior` values;
`response`-entry ack key = `resolution_id`; digest wrapper key sets; "expired ⇒ never delivered";
webhook stays directives-only; `inter_agent` requires `ack`.
**Verification:** audit finds zero mismatches; `ruby scripts/check-skill-frontmatter.rb` and
`bash scripts/check-frozen-identifiers.sh` pass locally; reference tests untouched.

## Scope Boundaries

- **In:** the six files above + this plan. Docs only.
- **Out (deferred):** `scripts/check-frozen-identifiers.sh` still pins `CURRENT_SPEC=spec/v0.4.md`
  (pre-existing; follow-up issue at reconcile time). Any spec-text change (if the audit finds a spec
  bug, file it — do not patch the spec here). Generated-skill code helpers beyond what the skills
  instruct implementers to port.

## Risks

- **Invented surface** (the acceptance killer): mitigated by U6's grep-confirm audit and by writing
  wire codes only where the spec states them.
- **Frontmatter YAML break** (silent skill non-load): descriptions containing `:` folded with `>-`;
  CI gate runs locally before push.
- **Over-length skills**: keep the load-bearing-map posture; link the spec instead of restating it.
