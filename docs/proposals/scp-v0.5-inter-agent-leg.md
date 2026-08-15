# SCP: MA2H v0.5 — the inter-agent leg (sessions, addressed envelopes, delivery honesty)

> Archived from [SCP issue #24](https://github.com/autnmy/ma2h-protocol/issues/24) (revision r2, review-hardened;
> sponsored by steward delegation 2026-08-10 — the design review record r1 → r2 is in the issue comments).
> Implemented by #25 (spec + schemas), #26 (reference), #27 (vectors), #28 (skills).


## Preamble
- **Author(s):** Tim Layton (drafted with Claude)
- **Status:** Implemented (r2, review-hardened) — sponsored by steward delegation 2026-08-10; shipped as spec v0.5 (2026-08-10)
- **Type:** Standards Track (normative)
- **Created:** 2026-08-10
- **Linked PRs:** [#29](https://github.com/autnmy/ma2h-protocol/pull/29) (spec + schemas), [#33](https://github.com/autnmy/ma2h-protocol/pull/33) (reference), [#31](https://github.com/autnmy/ma2h-protocol/pull/31) (vectors), [#35](https://github.com/autnmy/ma2h-protocol/pull/35) (skills) — via issues #25–#28

> r2: revised after a six-persona adversarial design review (coherence, feasibility, product,
> security, scope, adversarial). 17 actionable findings applied; the review record is in the issue
> comments. Material changes vs r1: addressed submits ack `queued` (never `delivered`), stream
> liveness requires client-originated proof (zombie-socket rule), bounce extends to drained-but-unacked
> mail on session death, a third `receipt` entry kind is defined, reachability derivation is split per
> consumption capability, terminal-session behavior is pinned at all three touchpoints, `inter_agent`
> is account-opt-in with a mandatory recipient policy, and the ack's `destination` object doubles as
> the version-misroute detector.

## Abstract

v0.5 adds an **inter-agent leg**: hub-mediated, store-and-forward messaging between agents of the
same account, plus the **session** primitive that makes it addressable and honest. Three changes, all
additive:

1. **Sessions** — a self-registered, hub-leased, ephemeral *address* under an existing `agent.id`
   (the credentialed *principal*). Sessions formalize the Caller (`agent.id` + `run_id`) into something
   registrable, addressable, and garbage-collectable. No new credentials: a session is an address, not a
   secret.
2. **Addressed envelopes** — the existing three verbs gain an optional `to` (`agent:<id>` or
   `agent:<id>#<session>`). An addressed `notify`/`ask`/`task` is accepted as `queued` and delivered
   through the §8.7 mailbox (signed, at-least-once, ack'd) instead of the human inbox; the addressee
   resolves an `ask`/`task` as an attested `agent:` actor and the Response routes back to the
   submitting session by the existing §6/§8 machinery. Three new mailbox entry kinds carry the leg:
   `message`, `response`, and `receipt`. The human inbox path is byte-for-byte unchanged when `to` is
   absent. The leg is **account-opt-in**: `inter_agent.enabled` defaults false.
3. **Reachability & delivery honesty** — per-session presence derived from client-originated activity,
   a destination-reachability snapshot on the submit ack, submit-time destination validation (no
   silent dead-letter), and terminal delivery-track states (`bounced`, `expired`) so a sender can
   always distinguish "seen" from "never seen." The hub never guarantees an agent is listening — it
   guarantees nobody is left believing a lie.

## Motivation

MA2H's defining deployment is a human coordinating many ephemeral agents through one Hub. In practice that
fleet now includes a **long-running coordinator agent** (an "overseer") that watches the fleet and drives
toward a milestone — and today it has no conformant way to reach the spokes, nor they it. Concrete gaps:

1. **No agent→agent path.** The v0.4 inbound leg routes by `to: agent:<id>` but restricts authorship to
   `^(human|system):.+$` (§13.1). An agent cannot notify, ask, or task another agent. §2's non-goals
   already anticipated the missing piece: a routed inbound response needs "an attested `agent:` actor on
   the return leg, a second signed leg." This SCP builds exactly that leg.
2. **No per-invocation addressing.** One `agent.id` credential is commonly shared by many concurrent
   invocations on one machine (the documented single-login setup). The mailbox is per-`agent.id`, so
   concurrent invocations race one destructive drain, and a message meant for *this* run can be consumed
   by *that* run. `run_id` is already on every envelope and defines the Caller (§1), but it is opaque,
   unregistrable, and explicitly non-authorizing (§9.1) — an audit label, not an address. Ephemeral
   invocations need an identity that exists only as long as they do and is cleaned up by the Hub, without
   minting per-run credentials (credential sprawl, human-gated creation, revocation debt).
3. **Silent unreachability is destroying trust in the inbound leg.** Agent→human works. Human→agent (a
   directive, or an answer to an `ask`) routinely lands in a mailbox nobody ever drains again — the
   agent's poll loop died, the session ended, and *nothing tells anyone*. The v0.4 spec is honest that the
   mailbox doesn't wake anyone (§2 non-goals), and presence (§15) gives a point-in-time hint — but nothing
   closes the loop when delivery never happens. The human believes the agent got the message; it didn't.
   A false belief of delivery is strictly worse than a visible failure: it silently converts the Hub from
   a trustworthy channel into a lottery, and operators respond by abandoning the inbound leg entirely.
   What stays broken if we do nothing: the inbound and inter-agent legs remain fire-and-forget-into-a-void
   for any agent whose listener isn't perfectly supervised — which is every real agent.

## Specification

Normative text follows; final wording lands in `spec/v0.5.md` + `schema/v0.5/` via the linked PR.
Amendment targets are given per v0.4 section numbers.

### S1. Sessions (new §16)

**Terminology (§1).** A **Session** is a Hub-registered, lease-bound, ephemeral addressing scope under one
`agent.id`. The **principal** (the `agent.id` + its credential) authenticates and is accountable; the
session locates one live invocation. Prior art: XMPP bare JID vs. full JID resource binding (RFC 6120),
SIP REGISTER contact bindings with `Expires` (RFC 3261), NATS ephemeral consumers.

**Registration — `POST /v1/sessions`** (agent credential, §9.1):

```json
{ "run_id": "run_01H...", "label": "dev-team · issue #612", "kind": "worker",
  "project": "web-app", "labels": { "repo": "acme/web-app" }, "ttl_seconds": 900 }
```

→ `201`:

```json
{ "session": { "id": "sess_01H...", "agent_id": "agnt_...", "state": "active",
  "created_at": "...", "expires_at": "...", "ttl_seconds": 900 } }
```

- The Hub **mints** `session.id` (as it does message ids, §8.1); ids match `^sess_`. A session id is not
  a secret and not a credential. All request fields are optional; `ttl_seconds` is a request the Hub MAY
  clamp to advertised bounds.
- A session belongs to the authenticating principal. A Hub MAY cap live sessions per `agent.id`
  (advertised); over-cap → `429`.
- Registration (and session-addressed `to`, S2) MUST be rejected for an `agent.id` containing `#` — the
  v0.4 schema places no charset constraint on agent ids, and `#` is the address separator (S2 grammar).

**Lease & renewal.** A session's lease is renewed only by **client-originated** authenticated activity
that references the session: registration, a drain (`?session=`), an inbox ack, a stream connect or
reconnect (S5), or a submit whose `agent.session` names it. A merely-open connection is NOT renewal
evidence (S5 pins the zombie-socket rule). There is still no dedicated heartbeat endpoint (mirrors
§15.1: the signal is real traffic) — with the S5 bounded stream hold, a healthy streaming bridge renews
at least once per freshness window automatically.

**States.** `active → closed` (explicit `DELETE /v1/sessions/{id}`, idempotent) or `active → expired`
(lease lapse, Hub clock §9.5). Both terminal and immutable (§7 first-terminal-wins). Terminal sessions
remain readable for a retention window (advertised), then are purged. On a session's transition to a
terminal state the Hub MUST apply the S4 bounce rules to its un-acked session-addressed mail.

**Terminal-session touchpoints (pinned).** A submit whose `agent.session` names an own-but-**terminal**
session → `410 destination_gone` (mirroring S2's rule for `to`); a valid but foreign-or-unknown session
in `agent.session` → `422`. See S5 for the drain-side rule and S3 for Response routing when the
submitting session dies before resolution.

**Authorization.**
- Only the owning principal's credential may register, renew, or close its sessions — with one
  exception: the account's authenticated **human** MAY close any account session (an attested, audited
  operator kill-switch; the S4 bounce rules then unblock any senders waiting on it).
- **Own-session visibility is unconditional:** `GET /v1/sessions` with an agent credential always
  returns the caller's own sessions (live and recent-terminal), independent of any policy — a restarted
  or crash-looping agent MUST be able to find, close, or let-lapse its stale leases before hitting the
  live-session cap. Another principal's session id MUST be indistinguishable from unknown (§9.1 stance).
- **Account-wide visibility:** the account's authenticated human MAY list/read all account sessions
  (extends §15.3's owner read). A Hub MAY additionally permit **same-account agents** to list/read
  account sessions (`sessions.agent_list_visibility`, advertised). Note this grant is fleet-wide, not
  scoped to a designated coordinator — scoped/role grants are a future possibility. Cross-account: never.
- **Discovery does not require the listing grant.** A session-registered agent participating in the
  inter-agent leg SHOULD include `agent.session` on its submits: the Hub-attested `from` on its traffic
  (S3) then carries a usable session-qualified address, so a coordinator learns worker addresses from
  the messages workers already send (and can bootstrap by principal-addressing known spokes).
  `agent_list_visibility` is an optimization for fleet dashboards, not the required discovery path.

**Envelope (§4.1).** The `agent` descriptor gains optional `session` (a `sess_` id owned by the
authenticated principal, else `422`; own-but-terminal → `410`). When present, the Caller's mailbox for
Response delivery is that session (S3). `run_id` is unchanged (audit label; still non-authorizing).
**Idempotency (§8.1) is unchanged in scope and additionally clarified:** `agent.session` and
`agent.run_id` are **excluded** from the identical-payload comparison — a crashed-and-restarted agent
retrying with the same `idempotency_key` from a new session/run MUST receive the original ack (the
recovery recipe §8.1 exists for), and the **original** submit's session remains the bound Caller for
Response routing (first submit wins).

### S2. Addressed envelopes (`to`) — amends §4, §5, §7, §8.1

The §4 envelope gains an optional **`to`**: `agent:<agent.id>` (principal-addressed) or
`agent:<agent.id>#<session.id>` (session-addressed). Absent `to` = the human inbox, unchanged.
`to: human:...` is invalid in 0.5 (multi-human routing remains a non-goal).

**Grammar (pinned).** The `#` separator is chosen because `:` already splits `<type>:<id>` and agent ids
may contain `/`. Within `to`, the **first `#` terminates the agent-id segment**; the session segment
matches `^sess_`. An agent id containing `#` cannot be session-addressed (and cannot register sessions,
S1), so principal and session forms parse unambiguously.

**Submit-time destination validation (MUST).** The Hub MUST validate `to` at accept time, within the
submitter's account: unknown `agent.id` → `422 unknown_destination`; session unknown → `422`; session
terminal → `410 destination_gone`. The same validation is RETROACTIVELY REQUIRED for the §13 directive
`to` (v0.4 left it unstated; accepting an unroutable destination and silently dead-lettering is the exact
false-belief failure S4 exists to kill). Cross-account addressing MUST be rejected identically to unknown
(no existence oracle). When the submitting agent lacks session/presence visibility for the destination
(S6/S1 policy), terminal-vs-unknown MUST collapse to `422 unknown_destination` for that sender — the
error split must not become a session-state oracle the visibility policy denies.

**Accepted status is `queued`, never `delivered` (amends §5.1/§7/§8.1).** An addressed message of any
verb — **including `notify`** — is accepted with `202 { "status": "queued" }`. v0.4's
delivered-on-acceptance rule for `notify` applies ONLY to the human-inbox (`to`-absent) path: an
addressed message is parked in a mailbox and may still bounce or expire unseen, so an ack asserting
`delivered` at accept time would itself be the false belief this SCP bans. An addressed `notify`'s
lifecycle IS the S4 delivery track (`queued → delivered | bounced | expired`); addressed `ask`/`task`
keep the §7 `open →` resolution machinery alongside the delivery track, as today.

**Routing.** An addressed message is enqueued in the destination mailbox (§8.7) rather than presented to
the human inbox. Session-addressed entries are visible only to drains presenting that session (S5);
principal-addressed entries are visible to any **session-presenting** drain by the destination principal —
**first-claim-wins** under the existing §8.7 visibility-timeout semantics. Principal addressing is **role
delivery**: a sender that intends a specific invocation SHOULD session-address, and multiple concurrent
sessions draining principal-addressed mail is the documented **degraded mode** of the shared-credential
setup (proper setup: per-session self-registration, with tooling auto-registering; a claimant session
that dies mid-processing is rescued by ordinary visibility-timeout redelivery to a sibling, which is why
the S4 bounce rules are scoped to session-addressed mail). Directives likewise MAY be session-addressed.

**Reachability snapshot on the ack.** The §8.1 submit ack for an addressed message MUST carry the
destination's current S6 reachability — `"destination": { "state": "online|offline|unknown", "last_seen"?: "..." }` —
so a sender (and its human) knows *at send time* whether this will be picked up promptly or is parked in
a durable mailbox. When the sender lacks visibility for the destination (S1 policy), the object MUST be
exactly `{ "state": "unknown" }` with no `last_seen` — still honest ("no promise of prompt pickup"),
never an ungated presence oracle.

**The ack is also the version-misroute detector (sender MUST).** Capability feature-detection is
time-of-check/time-of-use across rolling deploys and rollbacks: a mixed-version endpoint or a cached
capability document can put a `to`-carrying envelope in front of a pre-0.5 Hub, which ignores the
unknown field and misroutes the message to the human inbox. A pre-0.5 Hub cannot emit the `destination`
object, so: a 0.5 sender MUST treat an addressed-submit ack **without** `destination` as a misroute,
MUST surface the failure to its caller, and SHOULD cancel a misrouted `ask` via §8.4. (Feature-detection
via §8.0 before first use remains required; the ack check closes the deployment-window gap.)

### S3. The inter-agent legs — amends §5, §6, §8.7, §13; three new inbound entry kinds

The v0.4 drain returns `{ directive, signature }` entries. v0.5 adds three entry kinds, delivered
**only** to session-presenting drains (S5) so a 0.4 consumer never sees an unknown shape, and enumerated
in `inter_agent.entry_kinds`:

- **`message`** — an addressed §4 envelope (agent-authored `notify`/`ask`/`task`), with Hub-assigned `id`
  and Hub-attested `from` (`agent:<id>` or `agent:<id>#<sess>` of the authenticated submitter, session
  qualified when the submit carried `agent.session`). Never request-supplied — exactly the §13.1
  attestation rule.
- **`response`** — a §6 Response delivered to the submitting session's mailbox (the return leg for an
  agent-addressed `ask`/`task`, and available to any session-registered Caller in place of a webhook —
  ephemeral agents get push-grade latency over one connection with zero callback infrastructure, §9.4 SSRF
  surface included). A `response` entry is enqueued only when the submitting session is **live at
  resolution time**; if the Caller registered no session, or its session is terminal by then, delivery
  falls back to the unchanged v0.4 path — §8.2 pull (authoritative) and any §8.3 callback — with no
  bounce emitted. Dual-path delivery is safe: both channels carry the same `resolution_id` and the agent
  dedups on `(in_reply_to, resolution_id)`.
- **`receipt`** — a Hub-originated delivery-status notification to a **sender** (v0.5 uses it for the S4
  bounce). Fields: `in_reply_to` (the affected entry/message id — also its dedup key), `event`
  (`bounced` in v0.5), `prior` (`queued` | `delivered` — preserves the never-seen vs. seen-then-orphaned
  distinction), `at`, and the terminal session id. Signed per the §9.7 pattern with its own pinned
  context. Receipts are **best-effort, at-most-once-meaningful** (dedup on `in_reply_to` + `event`), are
  delivered only to live sessions of the sender, and MUST NOT themselves generate receipts — the
  sender's §8.2 pull remains authoritative.

**Resolution by an agent.** The addressee resolves an addressed `ask`/`task` through the existing resolve
action with its agent credential; the Hub attests `actor` as the session-qualified agent actor. This is
already half-blessed: §2.1 permits `actor = agent:<agent.id>`. For an addressed message the
`allowed_resolvers` **default changes from the v0.4 default (submitting principal) to the addressee**:
absent list ⇒ only the `to` principal (any of its sessions) may resolve — fail-closed, and the submitter
of an ask is the one party who must *not* answer it. The account's human is deliberately NOT a default
resolver for agent-addressed messages (list them in `allowed_resolvers` to opt in): the operator's
unstick recourse is the S1 session kill-switch — closing a wedged addressee's session bounces its queued
mail and auto-resolves its pending asks (S4) without the human impersonating an agent decision.
`request`/`action` blocks, modes, `expires_at`, `default_on_expire`, idempotency (§8.1 scope unchanged;
see S1 for the session/run exclusion), cancel (§8.4, submitter-bound), and the §7 CAS lifecycle apply
**unchanged**.

**Recipient duties (amends §13.4).** All §13.4 duties apply wholesale to `message` entries — they are
unsolicited inbound command surface. Two amendments: (1) the step-2 addressee check extends to the
session qualifier — the recipient MUST confirm `to`'s principal is itself AND, when session-qualified,
that the session is its **own current** session; (2) before *acting* on an addressed `ask`/`task`, a
conformant consuming agent MUST evaluate an **explicit, deployment-declared authorization policy** for
which `from` principals may ask/task it. The policy MAY be as permissive as "any same-account principal,"
but it MUST be an explicit, auditable configuration surfaced by tooling — never an implicit default of
the runtime. (This strengthens §13.5's SHOULD, which was written when the only inbound author was the
account's own human.)

**Human visibility.** Addressed messages default **out of the human triage inbox** (they are fleet
traffic, not human work) but MUST remain readable/auditable by the account's authenticated human — same
posture as §15.3 (the operator owns the account; agent↔agent traffic is not confidential from them). The
presentation is product.

### S4. Delivery honesty — amends §14

The §14.2 delivery track for mailbox entries (directives and `message` entries alike) gains two terminal
states:

```
queued ─▶ delivered ─▶ acknowledged
   │           │
   │           └──▶ bounced   (destination session went terminal after claim, before ack —
   │                           seen-then-orphaned; receipt carries prior: "delivered")
   ├──▶ bounced   (destination session went terminal while queued — never seen;
   │               receipt carries prior: "queued")
   └──▶ expired   (expires_at / retention passed while queued — never delivered)
```

- A delivery track reaching `expired` MUST mean **never delivered**: once `delivered`, later expiry of
  the *resolution* track never rewrites the delivery track. "Resolution `expired` + delivery `delivered`"
  = seen but unanswered; "delivery `expired`" = never seen. This one distinction is the
  anti-false-belief invariant the whole leg hangs on.
- **Bounce covers every un-ACKED entry, not only undelivered ones.** When a session goes terminal, each
  session-addressed entry that is not yet acked MUST transition to `bounced` — including entries a bridge
  drained but never acked (the §13.4 crash window): a terminal session can never re-drain, so
  "delivered-but-unacked to a dead session" would otherwise be a permanent orphan that the sender reads
  as delivered forever. The `receipt`'s `prior` field preserves the never-seen vs. seen-then-orphaned
  distinction.
- On bounce, an addressed **ask auto-resolves `cancelled`** and a **task `dismissed`**, with attested
  `response.actor: "system:undeliverable"` — no new resolution values, and the sender unblocks instead of
  waiting on a corpse. The §7 first-terminal-wins CAS makes this a harmless no-op when the addressee
  already resolved before dying.
- Senders learn of a bounce via their §8.2 pull (authoritative) and — when session-registered — a
  `receipt` entry (S3) so an open bridge learns immediately.
- **The ask/task response-delivery track gains the same terminal `expired`:** if message retention
  passes while the track is short of `delivered-to-agent`, the track terminates `expired` — the answer
  was **never seen** — surfaced on the human's §8.2/§14.4 `delivery` object like every other terminal.
  (Without this, "not picked up yet" and "never will be" present identically to the human who answered —
  the exact stranded-answer case in Motivation gap 3.)
- The submit ack, §8.2 GET, and receipts thereby give a sender one truthful ladder: reachability at send →
  `delivered`/`acknowledged` receipts → `bounced`/`expired` with a reason. At no point can "it's fine"
  and "nobody will ever see this" present identically.

### S5. Listening — session-scoped drain + optional stream; amends §8.7, §8.0

- **Drain opt-in.** `GET /v1/inbox?session=sess_...` returns, in addition to v0.4 directives:
  session-addressed entries for that session, principal-addressed entries (first-claim-wins), and
  `response`/`receipt` entries for that session. The presented session MUST be the caller's own: a
  foreign or unknown session → `404` (indistinguishable); the caller's **own-but-terminal** session →
  `410` — distinct by design, so a bridge returning from a lease lapse learns "re-register and continue"
  instead of treating its own address as nonexistent. A session-less drain returns exactly the v0.4
  shape — back-compat by construction. Ack (`POST /v1/inbox/ack`) is unchanged and covers all entry
  kinds.
- **Stream (OPTIONAL binding).** A Hub MAY offer `inbound.stream_url` (SSE): the same authenticated,
  session-scoped entries as the drain, pushed over a held connection; acks remain explicit POSTs.
  **Liveness requires client-originated proof — a merely-open socket is not evidence.** SSE is
  unidirectional and TCP half-open: the Hub cannot distinguish a live client from a crashed process
  behind a NAT whose socket still accepts buffered writes, so an open connection MUST NOT by itself
  renew the lease or presence. Instead: the Hub MUST bound each stream hold (advertised
  `inbound.stream_max_hold_seconds`, ≤ the presence freshness window) and close the stream at the bound;
  the client's **reconnect is the renewal** (standard SSE auto-reconnect makes this free for healthy
  clients), alongside the other client-originated activity in S1. A dead client never reconnects, its
  lease lapses within one freshness window, and S4 bounce fires — the zombie socket cannot hold a
  session `online`.
- **Stream delivery is provisional.** A stream push starts the entry's §8.7 visibility window exactly
  like a drain claim, but only **client-originated receipt evidence advances the delivery track**: a
  drain response (client-requested) stamps `delivered`; a server-originated stream push does not — a
  stream-delivered entry advances on its **ack** (or a later drain) and reverts to queued-visible after
  the visibility window otherwise. At-least-once is preserved; a push into a dead socket changes nothing
  the sender is told.
- Long-poll drain remains the conformance floor — a pull-only Hub is conformant; the stream is
  advertised capability, not a requirement.

### S6. Reachability — amends §15

Presence extends per-session: `last_seen` per S1's client-originated renewal events; states
`online|offline|unknown` per the advertised freshness window, evaluated per session. **Derivation is
split per consumption capability — one principal-level number would lie for one leg or the other:**

- **Addressed-message reachability (the S2 ack snapshot, and session/fleet reads):** derives from
  **session-bearing** activity only. `online` means a live session exists that could actually claim the
  entry. A destination whose only consumer drains session-less MUST NOT read `online` here — it can
  never be shown the entry, and reporting otherwise is the online-but-undeliverable false belief.
- **Directive presence (§15.3, unchanged):** keeps the v0.4 any-authenticated-drain derivation —
  a session-less v0.4 agent actively polling for directives stays `online` for the directive leg
  exactly as shipped; no regression.

The §15.3 read surface adds sessions (`GET /v1/sessions[/{id}]`, per S1's visibility rules).
**Truthfulness rule (MUST):** a Hub MUST NOT report `online` absent qualifying client-originated
activity within the window, and MUST NOT advance a mailbox entry's delivery track absent client-
originated receipt evidence (a drain response, an ack, or a §9.4-verified webhook 2xx — never a
server-originated stream push, per S5). Optimistic reporting is non-conformant.

### S7. Discovery & versioning — amends §8.0, §10, §2

- `ma2h_version: "0.5"`. Capability gains:
  - `sessions` — `enabled`, `max_ttl_seconds`, `max_live_per_agent`, `agent_list_visibility`;
  - `inter_agent` — `enabled` (**default false — the leg is account-opt-in**; enabling it is an explicit
    account-owner act, and a Hub MUST NOT accept `to`-addressed submits for an account that has not
    opted in), `entry_kinds` (`["message","response","receipt"]`), `sender_allowlists` (Hub support for
    per-destination sender restriction is REQUIRED; whether any allowlist is configured is per-account
    policy);
  - `inbound` additions — `stream_url?`, `stream_max_hold_seconds?`, `session_param: true`.
- **`inter_agent` requires the §14 primitive:** the S4 honesty states ride the §14.2 delivery track, so a
  Hub advertising `inter_agent` MUST implement `ack` (§14) including the S4 terminal states. Advertising
  `inter_agent` without `ack` is non-conformant.
- MINOR bump, no signature break: every v0.3/v0.4 wire format is byte-for-byte unchanged; new signed
  contexts belong to new features (push-parity threshold stays 3, §10).
- §2 non-goals amended: *agent liveness signaling* moves in scope (S6) — *wake/scheduling* stays out (the
  mailbox still never starts anyone; it now just refuses to lie about it). **Human→agent `ask`/`task`
  remains deferred**, but this SCP builds the attested `agent:` return leg §2 said it was missing, so that
  future SCP shrinks to a routing rule. Scope statement: this leg is **hub-mediated coordination among one
  account's agents** — not cross-account federation, not agent discovery, not an open agent mesh.

## Rationale & alternatives

**Why not adopt A2A for this leg?** Evaluated against A2A v1.0.1 (Linux Foundation, current): A2A is
strictly bilateral client↔server between HTTP-addressable agents. Its only async reach mechanism (push
notification config) requires the *recipient* to host an HTTPS webhook; there are no mailbox /
store-and-forward semantics, no registration/lease/expiry primitive, and multi-agent-behind-one-endpoint
is an explicitly open gap ("exposing an agent catalog is not the responsibility of an A2AServer" —
a2aproject/A2A#166/#641). MA2H spokes are HTTP clients with no inbound port and hour-scale lifespans —
the one topology A2A cannot address. The Hub already implements the missing layer (§8.7). Adopting A2A
here would mean building sessions, mailboxes, leases, and receipts anyway, then wearing an A2A costume
over the top. Instead we keep borrowing its shapes where they've earned it (§11 provenance: Part, task
lifecycle, capability discovery) and reserve genuine A2A interop for a future Hub-edge gateway (below).

**Why sessions instead of per-run agent identities?** Minting a principal per invocation means
human-gated creation, credential sprawl, and revocation debt for two-hour agents — and pollutes the
evergreen registry the credential model depends on. A session is data under an existing credential:
free to create, safe to GC, nothing to revoke. XMPP/SIP solved this split decades ago.

**Why first-claim-wins for principal-addressed mail?** Fan-out duplicates side effects (two sessions both
executing one directive is worse than a race); leader election is heavy machinery contradicted by the
mailbox model. §8.7's visibility timeout already implements claim semantics, including crash rescue
(an unacked claim redelivers to a sibling). Principal-addressed racing under multiple live sessions is
explicitly the **degraded mode**, not the design center — session addressing is the precise channel, and
tooling auto-registers sessions so proper setups get it by default. Queue-group-style delivery can layer
on later without wire changes.

**Why account-level opt-in plus a mandatory recipient policy, rather than per-verb default-closed?**
The review's sharpest security finding: v0.4's unsolicited inbound surface only ever carried the
account's own human as author; this SCP is the first place one compromised agent could command a fleet,
and r1 left the gate as a Hub MAY plus a recipient SHOULD. Per-verb asymmetry (task closed, ask open) was
considered and rejected: to an LLM recipient an `ask`'s request block enters context exactly as a `task`'s
instructions do, so the split buys mental-model complexity, not safety. The layered rule instead makes
trust explicit at every level without a per-message ceremony: the **account** opts in
(`inter_agent.enabled` default false — turning on agent↔agent comms is a deliberate owner act the product
surfaces at setup), the **Hub** must support per-destination sender allowlists, and the **recipient**
must act only under an explicit declared policy (which may be "any same-account principal" — one line in
a bridge config — but can never be an accident of the runtime). Dead-simple setup is preserved: one
toggle, one declared policy line, both scaffolded by tooling.

**Why the optional stream?** Ephemeral agents get push-grade latency over one outbound connection with
zero webhook/callback infrastructure (and none of §9.4's SSRF surface) — the "evergreen background
bridge" a supervised session runs. It is deliberately optional: long-poll remains the floor, and the
zombie-socket rule (S5) keeps the stream from ever outrunning the truthfulness invariant.

**Why reachability rather than guaranteed delivery?** Guaranteed delivery to a process nobody supervises
is unimplementable — §2 was right to scope out push-to-wake. The failure mode that actually erodes trust
is not "the agent was down," it's "nobody knew." Truthful state is implementable, cheap, and restores the
operator's mental model: *online → it'll see this now; offline → it's parked durably, and if it's never
seen, I'll be told.*

**Cost of not doing it:** coordinator topologies get built anyway — out-of-band, per-deployment, with
shared inboxes, screen-scraping, and polling scripts — and the inbound leg keeps its reputation for
losing messages.

## Backward compatibility

MINOR (0.4 → 0.5), additive. New `schema/v0.5/` snapshot per house convention: v0.4 schemas re-`$id`'d
unchanged except — `message` gains optional `to` + `agent.session`; **`submit-ack` gains optional
`destination`** (the v0.4 submit-ack schema is closed with `additionalProperties: false`, so this is a
listed change, not a silent carry-forward); `inbound-message` gains the `message`/`response`/`receipt`
entry kinds; `capability` gains the S7 objects; new `session.schema.json`; new §8.5 error codes
(`unknown_destination`, `destination_gone`). No existing `$id` changes.

A 0.4 agent: submits unchanged, drains unchanged (session-less drain returns only directives), never
sees new entry kinds. A 0.4 Hub: rejects nothing new for 0.4 traffic (unknown-field robustness, §10).
Two deliberate behavior changes to name:
- A 0.5 Hub rejects (`422`/`410`) directive submissions to unknown or terminal destinations that a 0.4
  Hub accepted and silently dead-lettered (S2's retroactive validation) — failing submissions fail
  louder, which is the point.
- A 0.5 sender MUST feature-detect via §8.0 before using `to`, and MUST treat an addressed-submit ack
  lacking `destination` as a pre-0.5 misroute (S2) — capability caching alone is TOCTOU across rolling
  deploys and rollbacks, and the ack is the deterministic detector.

No signature break; push parity unchanged.

## Security considerations

- **Trust boundary unchanged:** the account. Cross-account addressing MUST be rejected as unknown; the
  inter-agent leg creates no cross-account path. The leg itself is **account-opt-in**
  (`inter_agent.enabled` default false, S7).
- **Lateral movement is the threat model's center.** Prompt injection of one worker is the routine
  LLM-agent failure mode; under r1's defaults a compromised same-account agent could task every other
  agent while the traffic bypassed the human triage surface. v0.5 closes this in layers (S3/S7): account
  opt-in, REQUIRED Hub support for per-destination sender allowlists, a MANDATORY explicit recipient
  policy before acting on an addressed `ask`/`task`, and MUST-retained human auditability of fleet
  traffic. Verification still proves origin, not intent-safety — recipients treat verified content as
  data, not instructions (§13.4's strip-and-validate duties apply wholesale).
- **Attestation:** `from` on `message` entries is Hub-attested from the authenticated credential (+
  verified session), never request-supplied — same rule that keeps directives forgery-resistant (§13.1).
- **Session integrity:** ids are Hub-minted and non-secret; every session operation requires the owning
  principal's credential (plus the account-human kill-switch, S1); foreign sessions read as unknown.
  **Known limitation (documented):** sessions of the *same* principal share one credential and can
  therefore impersonate each other's session address — the in-scope threat model treats the principal as
  one trust domain; per-session derived tokens are Future possibilities, not v0.5.
- **No policy-bypassing oracles:** the S2 ack's `destination` snapshot and the 422/410 split are gated by
  the same visibility policy as session reads — an account that turns agent visibility off does not leak
  presence or session-state through the submit path (S2).
- **New surfaces bounded:** session registration and addressed submits ride existing per-`agent.id` auth
  + §8.6 rate limits; session caps bound registry growth; mailbox depth caps already bound queue abuse.
  Note that inter-agent chatter and the human leg share one per-`agent.id` §8.6 budget — a chatty
  coordinator can starve its own human-facing asks, so Hubs MAY advertise separate inter-agent quotas.
  Ask-loops between agents (A asks B asks A) are bounded by the same quotas; explicit hop-limits are
  listed as unresolved.
- **Privacy:** presence/session visibility widens only within the account; same-account *agent* read is
  policy-gated (and the grant is fleet-wide — S1 notes scoped grants as future work); §15.3's
  cross-account/public prohibition is unchanged. Receipts are delivered only to the affected sender.

## Conformance

Per class (§12): **Schema-validation** — `to` grammar (valid principal/session forms; `human:` rejected;
first-`#` split; `#`-bearing agent ids rejected for session use); `agent.session` shape; session
register/read envelopes; new capability objects; `message`/`response`/`receipt` entry kinds; submit-ack
`destination` shape; cross-type rules intact. **Signature obligations** — deterministic fixtures for
`message`, `response`, and `receipt` entry signatures (fresh `t`/`jti` per delivery; tampered
`from`/`to`/payload rejected; replayed `jti` rejected). **Downstream proofs** —
- session lease CAS (first terminal wins; renewal races; human kill-switch close);
- first-claim-wins under concurrent session-presenting drains (exactly one delivery per visibility
  window); crashed-claimant rescue via visibility-timeout redelivery;
- **stream-liveness truthfulness:** a session held only by an open stream with no client-originated
  activity past the freshness window reads `offline` and its lease lapses (zombie socket); a healthy
  client reconnecting at the advertised bound stays `online` continuously;
- **drain ownership:** `?session=` for a foreign/unknown session → `404`; for the caller's own terminal
  session → `410`;
- **stream-delivery provisionality:** a stream-pushed, never-acked entry reverts to queued-visible after
  the visibility window and its delivery track never left `queued`;
- bounce-on-terminal for **un-acked** entries incl. drained-but-unacked (receipt `prior` distinguishes
  `queued` vs `delivered`); ask auto-`cancelled`/task auto-`dismissed` with `system:undeliverable`;
  receipts dedup on `(in_reply_to, event)` and never cascade;
- delivery-track truthfulness (`expired` ⇒ never delivered, on the mailbox track AND the ask/task
  response track; no `online` without qualifying activity);
- **addressed-notify honesty:** submit ack carries `status: "queued"`; `delivered` only via the track;
- submit-time destination validation (unknown/terminal/cross-account rejected — no silent dead-letter);
  policy-tied ack detail (no-visibility sender gets `{"state":"unknown"}` and a collapsed `422`);
- **misroute detector:** an addressed submit acked without `destination` is surfaced as a failure by a
  conformant sender (and an ask is cancelled);
- idempotent replay from a new session/run returns the original ack; the original session stays the
  bound Caller;
- addressee-only resolver default (submitter's resolve rejected; account human rejected absent listing);
  session-qualified addressee check on the recipient (§13.4 step-2 extension);
- 0.4 session-less drain isolation (never receives new entry kinds).

## Reference implementation

Planned with the linked PR (per the conformance gate): `reference/src/hub.ts` grows the session registry,
addressed routing, bounce/expiry transitions, and entry signing; `reference/src/agent.ts` demonstrates the
bridge loop (register → stream/long-poll drain with bounded-hold reconnect → verify → policy-check → act
→ ack → close; loud distinct-code exits on auth failure, own-session `410`, signature failure). First
production implementation: the OH HAI Hub (tracking issue linked from this SCP).

## Unresolved questions

1. Exact signed-context field lists for `message`/`response`/`receipt` entries (pinned by vectors in the
   linked PR).
2. ~~`sessions.agent_list_visibility` default~~ — **resolved in r2:** advertised normative MAY;
   own-session visibility is unconditional (S1); discovery rides attested-`from` introduction (S1), so
   coordinators are portable to Hubs that keep listing off.
3. Whether principal-addressed entries should also bounce when the destination principal has **zero** live
   sessions *and* an `expires_at` (proposed: no — durable mailbox semantics win; `expired` covers it, and
   the S6 session-bearing derivation already makes the send-time snapshot read `offline`/`unknown`, so
   the sender knows it parked).
4. Hop/loop bounding for agent↔agent ask chains beyond rate limits (defer unless real).
5. Whether the §8.1 identical-payload comparison should formally exclude any other volatile descriptor
   fields beyond `agent.session`/`agent.run_id` (v0.4 pre-existing ambiguity; settle in the linked PR's
   §8.1 clarification).

## Future possibilities

- **Hub-edge A2A gateway:** the Hub is a durable HTTP server and can present account agents (or one
  coordinator) as A2A endpoints — signed Agent Card at the edge, A2A tasks mapped to addressed
  `ask`/`task`, internal delivery unchanged. Precedented (gateway-pattern A2A deployments); zero wire
  changes to this leg.
- **Per-session derived tokens** (closes the same-principal impersonation caveat).
- **Scoped visibility/role grants** (a coordinator-scoped session-list grant instead of the fleet-wide
  toggle).
- **Queue groups** for principal-addressed load-balancing; **human→agent `ask`/`task`** riding S3's
  return leg; session-scoped **threads** once multi-turn lands; richer `receipt` events (delivery,
  read) if senders need them.

