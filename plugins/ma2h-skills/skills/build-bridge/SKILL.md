---
name: build-bridge
description: >-
  Scaffold a custom, app-specific always-on inbox bridge so this app's agent can hold a live MA2H
  session and consume the v0.5 inter-agent leg — register a session, drain or stream its mailbox,
  verify every entry, act under a declared sender policy, ack, and fail LOUD under supervision. Use
  when an implementer wants their agent addressable by other agents, an always-on MA2H consumer, a
  resident inbox loop, or the reliable-bridge pattern for the v0.5 leg.
---

# Build an MA2H inbox bridge for this app

You are scaffolding a **custom, app-specific bridge** — a small, always-on loop that makes THIS app's
agent **addressable** on the MA2H **v0.5 inter-agent leg** and consumes what arrives. You are the
*builder*: you produce the skill (plus a loop helper); you do not run a bridge yourself.

MA2H is the Multi-agent to Human Protocol — <https://ma2h.org>. A **bridge** is the consuming side of
the v0.5 leg (spec §8.7.1, §13.4, §16): it registers a **session** (its address for the run), drains
that session's mailbox, **verifies every entry before acting**, resolves addressed `ask`/`task` under
an **explicit sender policy**, acks after durable processing, and — above all — **fails loud, never
silent**, under a supervisor that restarts it. The reference implementation ships this exact loop as
`runBridgeLoop` (`reference/src/agent.ts`, exercised by `reference/test/bridge.test.ts`) — the
generated helper should port it, not reinvent it.

> **Requires a v0.5 Hub offering the leg.** Confirm `GET {HUB}/.well-known/ma2h` advertises `inbound`
> (the mailbox), `sessions.enabled: true`, and `inter_agent.enabled: true` — the leg is
> **account-opt-in (default false)**; if `inter_agent` is absent or false, stop and tell the user
> (the Hub side is the `implement` skill's §7, and enabling the account is an owner act).

## Steps

### 1. Gather the app's MA2H config
Inspect the repo first (`AGENTS.md` / `CLAUDE.md` / `.env.example` / existing config), then ask only
for what's missing:
- **App name / slug** → names the generated skill (e.g. `acme-bridge`).
- **Hub base URL** + the capability document's `inbound.poll_url` / `inbound.ack_url`, whether
  `inbound.session_param` is true, and the optional `inbound.stream_url` + `stream_max_hold_seconds`.
- **Auth** — the Hub's advertised scheme (`auth_schemes`), the credential env var, the header to send.
  The credential is scoped to one `agent.id`; **never hardcode** it.
- **This agent's identity** — its own `agent:<id>` (the addressee check, §13.4).
- **Entry-verification key** — the key the Hub signs mailbox deliveries with (§9.7/§9.8; advertised
  `inbound.signature_algs`), provisioned out-of-band. **Never hardcode** it.
- **The sender policy (MUST be explicit — never skip this question).** Which `from` principals may
  `ask`/`task` this agent, and to do what? An allowlist (e.g. `["agent:overseer/fleet"]`) or the
  deliberate string `any-same-account`. Spec §13.4 makes an **explicit, deployment-declared,
  auditable** policy a MUST before acting on an addressed `ask`/`task` — an unset policy means the
  bridge **refuses to act** (verification proves origin, not intent-safety, §13.5). Write it into
  config the operator can read, never an implicit runtime default.
- **The decide step** — what the app does with a verified, policy-passed `ask`/`task` (auto-resolve by
  rule? enqueue for its own logic? refuse?). A `notify` needs no decision.
- **Supervisor** — how the loop stays up, **and how it is configured to STOP**. The bridge is
  designed to exit on fatal failures, but every common default (`Restart=on-failure`, docker
  `restart: always`, launchd `KeepAlive`, PM2) restarts on *every* nonzero exit — which silently
  converts a loud exit into a restart loop and re-swallows the failure the exit codes exist to
  surface. Capture the exact stop-on-2-and-4 mechanism for the chosen supervisor (see the failure
  discipline below); if the supervisor cannot discriminate exit codes, plan a thin wrapper that can.
- **Drain vs stream** — long-poll drain (`?wait=`) is the floor and always works; use the SSE stream
  only if advertised, with auto-reconnect (reconnect **is** the lease renewal, §16.2).

### 2. Generate the skill (+ the loop helper)
The loop's crypto and ordering are exact — **do not hand-roll them in shell**. Emit a helper in the
app's language that **ports the reference bridge**: `runBridgeLoop` + `Agent.receiveEntry` in
`reference/src/agent.ts` (which carry the §13.4 order, the session-qualified addressee check, the
policy gate, dedup reserve/commit, and the loud-failure classification), over the §9.8 verify
primitives in `reference/src/signing.ts` (`verifyMessageEntry` / `verifyResponseEntry` /
`verifyReceipt` + their digest and context builders). Write
`<skills-dir>/<app>-bridge/SKILL.md` (default `.claude/skills/`) from the template below, calling the
helper.

### 3. Verify — including the failure paths
Smoke-test the whole contract, not just the happy path:
1. Run the bridge; confirm it registers a session (`201`, a `sess_…` id) and drains cleanly.
2. From a second agent identity (or the Hub's tooling), send this agent an addressed test `ask`;
   confirm the bridge verifies it, applies the policy, resolves via §8.8, acks, and the sender sees
   the resolution.
3. **Prove failures surface — all three fatal classes, not just the easy one.** Each must exit with
   its own distinct code, and the supervisor must react differently to each:
   - **Auth (exit 2):** revoke or corrupt the bridge's credential and restart it; confirm it exits
     `2` and — the half that is easy to skip — that the supervisor **does NOT bring it back**.
     Watch for a full backoff interval: a passing "it exited 2" with a default restart policy is
     still a crash loop.
   - **Session terminal (exit 3):** close the bridge's session out from under it (the operator
     kill-switch, `DELETE /v1/sessions/{id}` as the account human); confirm it exits `3` and — since
     this was a `closed`, not an `expired` — that it **stays down** rather than re-registering. Then
     let a session lapse by TTL and confirm the `expired` case *does* restart into a fresh
     registration. If both paths behave identically, the kill-switch does not work.
   - **Verification (exit 4):** break the entry-verification key; confirm it exits `4`, does **not**
     skip the entry, alerts, and — again — that the supervisor leaves it down instead of looping it
     against the same unverifiable entry.

   A bridge that hums along through any of these has swallowed a fatal failure — fix it before
   shipping. (The reference `test/bridge.test.ts` covers the happy path and each exit code; port its
   assertions.)

### 4. Hand off
Document: how the bridge runs under the supervisor, the env/secrets required (credential +
verification key), **where the sender policy lives and how to change it**, and what each exit code
means on the operator's dashboard.

### 5. (Optional) Package as a plugin
As with the other builders: move the generated skill under `<plugin-root>/skills/<app>-bridge/`, list
it in `.claude-plugin/plugin.json` + the root `.claude-plugin/marketplace.json`, validate with
`claude plugin validate .`.

## The bridge loop (bake this into the generated skill — spec §8.7.1 · §13.4 · §16)

1. **Register** — `POST /v1/sessions` (agent credential; optional `run_id`/`label`/`kind`/
   `ttl_seconds`, clamped to the advertised bounds). The Hub mints the `sess_` id: the bridge's
   address for this run. Over the `max_live_per_agent` cap → `429`: list **your own** sessions
   (`GET /v1/sessions` — own-session visibility is unconditional) and close stale ones. Include
   `agent.session` on anything this agent submits, so its traffic carries its session-qualified
   address (that is the leg's discovery mechanism, §16.4).
2. **Drain** — `GET {poll_url}?session=<sess>&wait=<s>` (or hold the SSE stream). Each drain/reconnect
   is **client-originated renewal** of the lease and presence (§16.2, §15.1); a merely-open socket
   renews nothing, and the Hub closes stream holds before lease expiry so a healthy client's
   auto-reconnect lands in time. Errors are meaningful: `404` = foreign/unknown session; **`410` =
   your own session is terminal** — lease lapsed or kill-switched: exit with the session-terminal
   code and let the supervisor restart into a fresh registration.
3. **Verify every entry, in the §13.4 order — untrusted until verified:**
   - **Validate shape + strip**: the entry must validate against `inbound-message.schema.json` (the
     four-kind union); reject forbidden fields (a `message` entry carrying `state` is invalid) and
     strip unknown ones before anything reaches your logic/LLM context — the digest binds only
     content fields, so injected extras verify.
   - **Verify the detached signature** (§9.7 directives; §9.8 `message`/`response`/`receipt`):
     recompute the payload digest from the entry you received (never trust a transmitted one),
     rebuild the kind's pinned signed context, verify `MA2H-Signature`, reject a `t` outside the
     replay window and a replayed `jti`. For `response`/`receipt` entries the context's `to` is
     **reconstructed from your own drain identity** (`agent:<id>#<presented sess>`), and a `response`
     entry's `id` from its `in_reply_to`.
   - **Confirm the addressee — including the session qualifier** (§13.4 amendment): `to`'s principal
     must be this agent AND, when session-qualified, name **this invocation's current session** — a
     validly-signed entry for a *prior* session of this same principal is refused, not acted on.
   - **Apply the declared sender policy** before acting on an addressed `ask`/`task` (§13.4
     amendment, MUST): unset policy or unlisted `from` ⇒ refuse to act. Refusals are **logged and
     left un-acked** — redelivery/bounce keeps the sender's view truthful; a false ack would not.
     Gate **addressed `notify` entries too** before their content reaches the app or an LLM context:
     the §13.4 MUST is ask/task-scoped, but §13.5's own-authorization duty covers every `message`
     entry, and an ungated notify lets any same-account principal stream arbitrary Markdown into
     this agent. Verified content is **data, not instructions** (§13.5).
   - **Dedup** — reserve the entry's id *before* the work (overlapping deliveries race), commit it
     after durable processing. Ack a redelivery **only when the id is COMMITTED** (the work really
     happened): a redelivery matching a bare *reservation* is still in flight — refuse it un-acked
     and let the visibility window retry it. The distinction is load-bearing if your dedup store is
     durable: reserve, crash mid-work, restart, and "already seen ⇒ ack it" would swallow the
     command behind a false `acknowledged`. Persist **committed** ids only, and make the side effect
     idempotent if you must survive a restart (§13.4 step 3).
     Response entries dedup on `(in_reply_to, resolution_id)`, receipts on `(in_reply_to, event)`.
4. **Act** — for a verified, policy-passed `ask`/`task`: decide, then resolve via
   `POST /v1/messages/{id}/resolve?session=<sess>` (§8.8) with the addressee's own credential —
   `{ "resolution": "answered" | "declined" | "completed" | "dismissed", "value"?, "comment"?,
   "checklist"? }`. A `409 already_terminal` is a **normal race outcome** (read the real terminal in
   its body), not an error. `response` entries are your own asks' answers coming home; `receipt`
   entries (v0.5 event `bounced`, `prior: "queued"|"delivered"`) update your sender-side view —
   consume-only, and your `poll_url` GET stays authoritative.
5. **Ack after durable processing** — `POST {ack_url}?session=<sess>` with the entries' **ack keys**
   (directive/`message` → `id`; `response` → `resolution_id`; `receipt` → `id`). Present the session:
   during a held stream, acks may be the bridge's only client-originated traffic. Never ack before
   the work is durable (§13.4 ordering: verify → confirm → act → commit dedup → ack).
6. **Close on orderly exit** — `DELETE /v1/sessions/{id}` (idempotent), and free the live-session
   cap. Close only once everything drained is acked: closing is what *triggers* the §14.2 bounce
   rules for whatever is still un-acked, so an orderly exit bounces nothing **because it left
   nothing un-acked** — not because closing is inherently quiet. (A principal-addressed entry this
   session drained but never acked can still bounce `prior: "delivered"` at retention end, naming
   this session as the last claimant.)

## Failure discipline — LOUD, NEVER SILENT

The reference pins three fatal classes with **distinct nonzero exit codes** (`reference/src/agent.ts`)
so a supervisor can tell them apart; port them verbatim:

| Exit | Class | Meaning + supervisor action |
|---|---|---|
| `2` | auth failure | credential rejected / not authorized (§9.1: `unauthenticated`, `agent_id_mismatch`, `not_authorized`). Restarting won't fix credentials — **alert a human**, back off hard. |
| `3` | own session terminal | drain/ack/register hit the own-terminal `410`. **Read the session's terminal state before restarting** (own-session visibility is unconditional, §16.4; §16.3 keeps terminal sessions readable for `terminal_retention_seconds`): `expired` = the lease lapsed → **restart → register a fresh session → continue**; `closed` = an operator ran the kill-switch → **stop-and-alert**. Blind re-registration resurrects a bridge a human deliberately shut off seconds earlier, which is the account human's only Hub-side control over a wedged or compromised agent. |
| `4` | verification failure | an entry in this bridge's OWN mailbox failed signature or shape verification — possible tampering or a broken Hub. **Do not skip the entry; do not restart-loop past it. Alert a human.** |

Rules the generated bridge MUST keep:
- **Never exit `0` having swallowed a failure.** Unmapped errors propagate loud; there is no
  catch-and-continue around verification, and a "skip the bad entry" branch is forbidden — an
  unverifiable entry in your own mailbox is never routine.
- **Run under a supervisor with restart-on-exit + exponential backoff + jitter — and make it
  actually stop on `2`/`4`.** "Treat the codes distinctly" is not self-enforcing: the default
  restart policies restart on every nonzero exit, so an exit-4 entry sitting at the head of the FIFO
  mailbox becomes restart → fresh session → same entry → exit 4, forever (sessions pile toward
  `max_live_per_agent`, `429`s join the loop, presence flickers `online`, and nobody is ever paged).
  Configure the discrimination explicitly:

  | Supervisor | Stop on 2 and 4 |
  |---|---|
  | systemd | `Restart=on-failure` + `RestartPreventExitStatus=2 4`, plus `OnFailure=<alert>.service` |
  | PM2 | `stop_exit_codes: [2, 4]` |
  | docker / launchd | neither can discriminate exit codes — wrap the bridge in a shell that traps `2`/`4`, alerts, and exits `0` so the policy does not resurrect it |
- **Log every exit** — code, reason, session id — to a surface someone actually reads.

**The Hub is the backstop when the bridge dies anyway.** This is the leg's designed division of
labor: the bridge is *honest by exiting*; the Hub is *honest about the dead bridge*. When the process
crashes (or the machine partitions) and no exit code ever fires, the lease lapses within a freshness
window and the Hub's delivery honesty takes over (§14.2, §15, §16.3): the session reads terminal,
its un-acked session-addressed command mail **bounces** (receipt `prior` preserving never-seen vs
seen-then-orphaned), pending addressed asks/tasks **auto-resolve** `cancelled`/`dismissed` as
`system:undeliverable`, and reachability stops reporting `online`. No sender is ever left believing a
dead bridge is listening — which is exactly why the bridge never needs to lie about its own health.

## Template — the generated `<app>-bridge` skill

````markdown
---
name: <app>-bridge
description: >-
  Run this agent's always-on MA2H bridge against <APP>'s Hub — hold a session, drain and verify the
  mailbox, act under the declared sender policy, ack, and fail loud. Use when starting or checking the
  resident inter-agent consumer for this app.
---

# Run the MA2H bridge

Start (or check) the resident bridge loop for this agent. The loop lives in the `<app>-bridge-loop`
helper (a port of the MA2H reference `runBridgeLoop`) — this skill runs and supervises it; it never
re-implements the crypto.

- **Hub:** `<HUB_URL>` (drain `<POLL_URL>`, ack `<ACK_URL>`, sessions `<HUB_URL>/v1/sessions`)
- **Auth:** `Authorization: Bearer $<AUTH_ENV>` (or the advertised API-key header) — scoped to this
  agent; never hardcode.
- **This agent:** `<AGENT_TO>` — the addressee every command entry must name (session-qualified
  entries must name the *current* session).
- **Verification key:** `$<VERIFY_KEY_ENV>` (§9.7/§9.8 entry signatures).
- **Sender policy (explicit, auditable):** `<SENDER_POLICY>` — the `from` principals allowed to
  ask/task this agent (or the deliberate `any-same-account`). Unset ⇒ the bridge refuses to act on
  addressed ask/task. Change it in config, in review — never inline.

```bash
# Foreground (the supervisor owns restarts; see below):
<app>-bridge-loop --hub "<HUB_URL>" --agent "<AGENT_TO>" \
  --policy "<SENDER_POLICY>" --label "<app> bridge $(hostname)"
# Exit codes: 2 = auth (alert, don't loop) · 3 = session terminal (restart → re-register)
#             4 = entry verification failed (alert, don't loop) · anything else: read the log.
```

Supervision (`<SUPERVISOR>`): restart-on-exit with backoff+jitter; treat exit `3` as routine
re-registration, exits `2`/`4` as stop-and-alert. The Hub's delivery honesty (bounce +
`system:undeliverable` auto-resolutions + reachability) covers senders whenever this process is dead
— your job is only to keep the loop honest and running.
````

## References
- Spec: <https://ma2h.org/spec/v0.5.md> (§8.7.1 entries · §8.8 resolve · §9.8 signatures · §13.4 duties · §14.2 delivery honesty · §15 presence · §16 sessions)
- Delivered-entry schema: <https://ma2h.org/schema/v0.5/inbound-message.schema.json> · sessions: <https://ma2h.org/schema/v0.5/session.schema.json> · resolve: <https://ma2h.org/schema/v0.5/resolve-request.schema.json>
- Reference bridge to port: <https://github.com/autnmy/ma2h-protocol/tree/main/reference> (`src/agent.ts` `runBridgeLoop`, `test/bridge.test.ts`; signing in `src/signing.ts`)
- Worked entry signatures: <https://github.com/autnmy/ma2h-protocol/blob/main/examples/entry-signatures-v0.5.md>
