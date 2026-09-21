# SCP: MA2H v0.7 — an address that survives a lease lapse (lapse-revival vs. a Hub-bound name)

> Draft for [SCP issue #69](https://github.com/autnmy/ma2h-protocol/issues/69) — filed, not yet
> sponsored. Drafted against [`spec/v0.6.md`](../../spec/v0.6.md) and the published vectors `dp-019`, `dp-021`, `dp-022`.
> This document proposes and compares; it changes no spec text, no schema, and no vector. The `v0.7`
> in the file name is the minor this would ship in if accepted as written (additive, MINOR); it is
> provisional until the steward rules.

## Preamble
- **Author(s):** Tim Layton (drafted with Claude)
- **Status:** Draft
- **Type:** Standards Track (normative)
- **Created:** 2026-09-20
- **SCP issue:** #69
- **Linked PR:** — (document PR #68; an implementation PR follows a ruling on the Recommendation)
- **Scope:** Option A touches §16.1, §16.2, §16.3, §16.4, §16.4.1, §14.2, §8.0, §8.5 and `dp-019`.
  Option B touches §4 (the `to` grammar), §8.0, §8.1, §8.5, §8.7.1, §13.2, §13.4, §14.2, §16.1,
  §16.4, §16.4.1, §16.5, adds a cross-reference in §16.3, and adds vectors; it leaves §16.2, the
  §16.3 state machine, and `dp-019` untouched. Neither option changes a signed context (§9.7, §9.8).
- **Related (first implementation's tracker):** autnmy/oh-hai#1170 (the measurement), autnmy/oh-hai#990
  (the prior analysis this builds on), autnmy/oh-hai#989 (a task addressed to a session after the run
  rolls), autnmy/oh-hai#902 (mail inserted after the bounce is never settled).

## Abstract

An agent's precise address is `agent:<agent.id>#<session.id>` (§4). A session is lease-bound (§16.2),
and a lapsed lease is a terminal, immutable state (§16.3). The next registration by the very same
invocation is therefore minted a **new** id, and every holder of the old address bounces. Lease
renewal requires client-originated traffic (§16.2), and an agent inside one long synchronous step — a
test suite, a build, a long model call — can originate none. So a healthy agent loses its address
*because it is busy*, and the cost lands on the peers doing business with it.

This SCP asks whether the protocol should give an invocation an address that survives a lapse, and
compares three answers: **0** — do nothing at the protocol level; **A** — *lapse-revival*, in which
a lapse becomes a bounded, non-terminal grace state the same run may leave under the same id; and
**B** — a *Hub-bound name*, a third `to` form (`agent:<id>#name:<name>`) that resolves at the Hub to
whichever live session currently holds the name, with never-seen mail held for an advertised window
while the name is unbound. It recommends **B**, and says plainly what the steward must decide.

## Motivation

### The mechanism

Five sentences of v0.6 produce the behavior, and each is individually right:

- §16.2: *"A session's lease is renewed only by **client-originated** authenticated activity that
  references the session"* — and *"There is still no dedicated heartbeat endpoint."*
- §16.3: *"`active → expired` (lease lapse, Hub clock §9.5). Both terminal and **immutable**
  (first-terminal-wins, §7)."*
- §16.3: *"On a session's transition to a terminal state the Hub MUST apply the §14.2 bounce rules to
  its un-acked session-addressed command mail."*
- §4: *"session terminal → `410 destination_gone`."*

Together: an invocation that is silent for one TTL loses its id forever, its queued mail bounces, and
later sends to the id are refused. §16.3's own recovery text — `410 gone` means *"re-register and
continue"* — restores the agent's ability to *receive*, at a new address nobody holds.

### The measurement

From the first production implementation (autnmy/oh-hai#1170): one account, roughly twenty
long-running agents exchanging addressed mail, a 900-second default lease. In eight hours there were
**17 address changes across 9 agents; one agent changed address five times.** Every lapse examined had
the same cause: a single synchronous step longer than the lease, during which the agent's runtime
could not originate any request. Each change cost a re-announcement to every peer, a re-send of every
message that bounced in the gap, and a window in which commands were lost. The second-order failure
was recorded by the agents themselves: an agent read its id, published it, and its next re-registration
took a new one — a session id is only true at the moment it is resolved.

### Why it is general

It needs two parties and one long step. Agent runtimes commonly execute tool calls synchronously; a
sixteen-minute test run is ordinary; the peers who most need to reach a busy agent are the ones whose
work it is doing. The social mitigation — "re-publish your address" — presumes a place to publish and
a sender that re-reads it at send time. A webhook source configured once, a human's saved directive
target, or a peer holding a cached `#sess_…` address has no such step.

### What is *not* broken (from the prior analysis, autnmy/oh-hai#990)

- **An awaited answer is not lost.** §16.3's touchpoint row *"Response due to it (§6)"* reads *"fall
  back to §8.2 pull / §8.3 callback; **no bounce**"*. Only the *address* lapses: new inbound command
  mail, and a peer's send to the old id.
- **The obvious fix is closed.** A sixth renewal source (renew on the §8.2 pull, or a heartbeat
  endpoint) contradicts §16.2's closed list, which `dp-019` obligation (4) restates verbatim; a
  sustained non-consuming renewal also manufactures the *online-but-undeliverable* belief `dp-021`
  obligation (7) bans. That analysis concluded: *"If the address itself must survive a long wait,
  that is an SCP against §16.2/§16.3/§15.1 plus `dp-019`, not a Hub patch."* This is that SCP. It
  deliberately proposes **no new renewal source**; both options below leave §16.2's list as it is.

## Specification

Three options. Normative wording is a sketch at the precision needed to compare them; final text
lands with the implementation PR for whichever the steward accepts.

### Option 0 — do nothing at the protocol level

The protocol already has two levers, both in flight in the first implementation:

1. **A longer lease.** `ttl_seconds` is a registration request the Hub clamps to
   `sessions.max_ttl_seconds` (§16.1). A client that knows it runs thirty-minute steps can ask for a
   thirty-minute lease (autnmy/oh-hai PR #1174 exposes this as client configuration).
2. **Client-side label resolution.** A sender resolves a session `label` (§16.1) to a live session id
   through `GET /v1/sessions` at send time, then session-addresses as today (autnmy/oh-hai#986).

**Real cost.** These shrink the problem; neither removes it.

- A longer lease moves the cliff; it does not remove it. Any step longer than the clamp still loses
  the address, and the clamp is the Hub's, not the agent's. The price is paid by everyone else: a
  *crashed* run's session now stays `active` for the whole longer TTL, holding a slot against
  `sessions.max_live_per_agent`, and its senders wait that much longer for the §14.2 bounce that
  tells them the truth.
- Label resolution is a *lookup*, not an *address*. It requires the listing grant (§16.4 —
  `agent_list_visibility` is a ceiling a Hub MAY narrow per account, and §16.4 is explicit that
  *"Discovery does not require the listing grant"*, so a conformant sender may not have it). It is
  time-of-check/time-of-use: the id can go terminal between the lookup and the submit. `label` is
  *"Free-form human-readable"* (`session.schema.json`) and not unique, so two sessions may share one.
  It helps only new sends by senders that perform it: mail already queued to the old id still
  bounces, and any party that stored the `#sess_…` form — a webhook source, a saved directive target
  — is cut off.

Option 0 is the right answer if the steward judges address continuity a deployment concern. Its cost
is that every deployment then builds a registry on the side, which is the pattern §16 was written to
end.

### Option A — lapse-revival

**The honest form of A does not revive a terminal; it makes a lapse non-terminal for a bounded
window.** A literal "revive an `expired` session" contradicts §16.3 (*"terminal and immutable"*),
`dp-019` obligation (5) (*"no post-terminal resurrection"*), and the §16.3 marker argument that leans
on immutability (*"terminals being immutable — a `closed` session never later flips to `expired`, so
the marker never appears and then vanishes"*). It would also have to un-bounce mail, which §14.2 and
§7's first-terminal-wins make impossible: **a bounce is final, and nothing in this SCP reverses one.**
That form is rejected below (Rationale, A′). What follows is the form that keeps terminals immutable.

**A1. State machine (amends §16.3).**

```
active ─▶ lapsed ─▶ active     (revival, within the window, by the same run)
   │         ├────▶ expired    (window elapsed — terminal, immutable, as today)
   │         └────▶ closed     (explicit DELETE, or the §16.4 operator close — terminal)
   └──────────────▶ closed     (unchanged)
```

On lease lapse a **revivable** session (A2) enters `lapsed` for the advertised
`sessions.revival_window_seconds`; a non-revivable one goes `active → expired` exactly as today.
`lapsed` is not terminal, so no §14.2 bounce fires on entering it; the §16.3 bounce obligation is
unchanged in wording and fires on `lapsed → expired` and `lapsed → closed`. `closed` — by the owner's
`DELETE` or by the §16.4 operator — is **never** revivable from any state; nor is `expired`.

**A2. Revival (amends §16.1).** `POST /v1/sessions` gains an optional `revive` member naming a
`sess_` id. The Hub revives iff **all** hold: the credential is the owning principal's; the session
is `lapsed`; the request's `run_id` equals the `run_id` the session was registered with (a session
registered without a `run_id` is not revivable); and the §16.4.1 registration gate does not refuse
the principal. Success → `200` with the **same** `session.id`, `state: "active"`, a fresh lease.
Otherwise the Hub MUST NOT fall through to minting a new session on the same request: `409
revival_refused` (`run_id` mismatch, not `lapsed`), or the §16.3 presentation readings (`410 gone`,
`410 session_closed_by_operator`, `404`). Registration is already a §16.2 renewal source, so the
closed list and `dp-019` obligation (4) stand unedited.

**A3. Touchpoints while `lapsed` (new §16.3 column).** Presenting it (drain / ack / resolve / stream
connect): `410` with the additive code `session_lapsed` — *"revive, do not re-register"*. Under the
§8.5 unknown-code fallback a pre-0.7 client reads `gone` and re-registers under a new id: it keeps
working, keeps today's behavior, and the abandoned `lapsed` session expires and bounces at window
end. Submit naming it in `agent.session`: `410 destination_gone` (unchanged; the run must revive
first). Addressed `to` naming it: **accepted**, `queued`/`open`, with the `destination` snapshot
reading `offline` (its `last_seen` is by construction older than the freshness window, §15.2).

**A4. Mail in the window — hold, and why.** Mail queued before the lapse, and mail arriving during
`lapsed`, is **held** `queued`; drained-but-unacked entries revert to queued-visible by the ordinary
§8.7 visibility timeout and are redelivered after revival (the reviver is the same run, so its
§13.4 step-3 dedup state is plausibly intact). Bounce-on-lapse was considered and rejected: it
preserves the id while still destroying every message the id was holding, which removes the
re-announcement cost and leaves the two larger costs in the measurement — re-sent mail and lost
commands — exactly where they are. The price of holding is stated under *Delivery-honesty cost*
below and is the same for B.

**A5. Presence and the cap.** A `lapsed` session MUST NOT read `online` (§15.1 truthfulness) — it
cannot, since nothing renewed it. It MUST count toward `sessions.max_live_per_agent`: it holds an
address and mail. A crash-looping client that never revives therefore accumulates `lapsed` sessions
for one window each; §16.4's unconditional own-session visibility is what lets it find and `DELETE`
them, and the listing MUST include `lapsed` sessions for that reason.

**A6. Wire delta.** `registerRequest.revive` (string, `^sess_`); session `state` enum gains `lapsed`
and the resource gains `lapsed_at`; capability `sessions.revival_window_seconds` (absent ⇒ not
offered); §8.5 codes `session_lapsed` (410, refines `gone`) and `revival_refused` (409). `dp-019`
obligation (5) is reworded from a two-terminal machine to the A1 machine, keeping *"no post-terminal
resurrection"* verbatim.

### Option B — a durable, Hub-bound name

**B1. The name.** `POST /v1/sessions` gains an optional **`name`** matching
`^[a-z0-9][a-z0-9._-]{0,62}$`, scoped to `(account, agent.id)`. A session holds at most one name in
this revision. The Hub keeps a **name binding** — `{ agent_id, name, session?, unbound_at? }` — in
storage independent of any session resource, as §16.4.1 already does for the stop record. `name` is
a new field, not a reuse of `label`: `label` is free-form human text, already deployed non-uniquely,
and carries characters no address grammar can hold.

**B2. Grammar (amends §4) — and why not `@`.** The third `to` form is

```
agent:<agent.id>#name:<name>
```

`agent:<id>@<name>` **collides with the existing grammar.** §16.1 says *"the schema places no charset
constraint on agent ids"*, and `message.schema.json` types `to` as `^agent:[^#]+(#sess_.+)?$` — so
`agent:ops@example` is, today, a valid principal address for the agent id `ops@example`. `#` is the
only character §4 reserves (*"the **first `#` terminates the agent-id segment**"*), so a new form
must live behind it. `name:` can never match `^sess_`, so the three forms parse unambiguously, and
every rule that already keeps `#`-bearing agent ids out of the leg (§4 sender-side symmetry, §16.1)
covers the new form unchanged.

The choice also buys the version gate for free. §4 says *"the session segment MUST match `^sess_`"*
and vector `sv-020` pins `agent:foo#bar` as invalid, so a 0.5/0.6 Hub **rejects** a name-addressed
envelope at validation. A sender that skipped feature detection gets a clean `4xx`, never a silent
misroute. (A pre-0.5 Hub ignores `to` altogether; the existing §8.1 rule — an addressed ack without
`destination` is a misroute — already covers that.)

**B3. Claiming and takeover (amends §16.1).** At registration:

| The name is… | Result |
|--------------|--------|
| free (never claimed, or released) | bound to the new session; `201` echoes `session.name` |
| **unbound-held** (last holder lapsed, hold window open, B5) | re-bound to the new session; held mail becomes drainable by it |
| bound to a **live** session of the same principal | `409 name_in_use` — **first holder wins, loudly** |
| under an operator stop (B7) | `403 session_closed_by_operator` |

A live holder is displaced only by its own `DELETE`, its own lease lapse, or the operator close.
"Newest claimant wins" was rejected: two honestly misconfigured runs sharing a name would silently
steal it from each other on every re-registration, and mail would alternate between them; a `409` is
the visible failure. A refused claim MUST fail the registration rather than mint an unnamed session —
a run that asked for a name and did not get one must not come up believing it is reachable by it.

Re-binding an unbound-held name does **not** require a matching `run_id`. This is deliberate, and it
is the semantic a sender opts into: §8.7.1 calls principal addressing *"**role delivery**"* and tells a
sender that *"intends a specific invocation"* to session-address. A name is the narrow middle — one
holder at a time, continuity across re-registration — and a supervisor restarting a worker under a
new `run_id` is a legitimate re-binder. A sender that means *this invocation and no successor* keeps
using `#sess_…`, which B leaves byte-for-byte unchanged.

**The registration echo is the feature detector (client MUST).** `registerRequest` is an open object
and §10 requires a Hub to *"**ignore unknown fields**"*, so a pre-0.7 Hub accepts a `name`-bearing
registration and returns a session with no name — a silent degradation. A client MUST treat a `201`
whose `session` lacks `name` as *not bound*, MUST NOT publish the name, and SHOULD surface the
failure. This is the §8.1 misroute detector's pattern applied to registration, for the same
time-of-check/time-of-use reason.

**B4. Routing and delivery (amends §8.7.1, §13.2, §13.4).** A name-addressed `message` entry or
directive is queued against the **name binding**, and is visible to a drain presenting the session
the name is currently bound to — alongside that session's session-addressed mail and the principal's
first-claim-wins mail. The delivered entry's `to` is the address as submitted
(`agent:<id>#name:<name>`); it is bound in the §9.7/§9.8 signed contexts as the string it already is,
so **no context changes**. §13.4's step-2 addressee check gains its third arm: the recipient MUST
confirm the principal is itself AND that `<name>` is the name **its own current session holds**.
`from` stays session-qualified exactly as today (Unresolved question 1).

**B5. Hold, then bounce (amends §14.2; §16.3 gains only a cross-reference).** When a name's holder goes terminal:

- by **lease lapse** → the binding becomes *unbound-held* for the advertised
  `sessions.names.hold_seconds`. Name-addressed entries still `queued` (never drained) stay `queued`
  and are delivered to the next holder. Entries already `delivered` but un-acked **bounce now** with
  `prior: "delivered"`, exactly as today — the next holder may be a different run with no §13.4 dedup
  state, and redelivering a command its predecessor may have executed is the one failure a hold must
  not introduce (Unresolved question 3).
- by the owner's **`DELETE`** or the **operator close** → the name is released (B7 for the stop) and
  every un-acked name-addressed entry bounces at once. A stand-down is a statement that nobody will
  read this.
- at **hold expiry** with no re-binding → the remaining held entries bounce with `prior: "queued"`,
  addressed `ask`/`task` auto-resolve by `system:undeliverable` (§7), and the name is released.

Submit-time validation (§4) for a name: bound or unbound-held → accepted, `queued`/`open`, with the
REQUIRED `destination` snapshot (an unbound-held name reads `offline` with the last holder's
`last_seen`, or exactly `{ "state": "unknown" }` for a sender without visibility); released within
`terminal_retention_seconds` → `410 destination_gone`; never claimed, purged, or a Hub not offering
names → `422 unknown_destination`, with the §4 collapse rule for senders without visibility.

Every §14.2 invariant survives without rewording. Nothing bounced is un-bounced. `expired` still
means never delivered (an entry's own `expires_at` still fires during a hold). The bounce receipt's
REQUIRED `session` names the **last session the name was bound to**, which is always a terminal
session, so `inbound-message.schema.json`'s receipt and the frozen six-key §9.8 digest are unchanged.
Session-addressed mail to the lapsed session bounces exactly as today: the hold applies to the name,
never to the id. And the §16.3 state machine is untouched — `active → closed | expired`, both
terminal, both immutable.

**B6. Listing and discovery (amends §16.4).** The session resource gains optional `name`, exposed
under exactly §16.4's visibility rules. A holder publishes its name in-band or out of band once;
unlike a session id it stays true. No name directory is proposed (§2 keeps agent discovery out of
scope).

**B7. The kill-switch attaches to the name (amends §16.4, §16.4.1).** Today an operator close has a
side effect operators rely on even on a cooperative Hub: the killed run's address dies with it, so a
run that re-registers through the kill comes back at an address nobody holds. A re-bindable name
would erase that — the run re-registers, re-claims the name, and mail flows as if nothing happened.
So: an operator close of a session holding a name MUST place the **name** under the same stop. On
every Hub offering names, a claim on it is refused `403 session_closed_by_operator` for at least
`terminal_retention_seconds` (the life of the cooperative marker); on a Hub advertising
`operator_hard_stop`, until the account's human lifts the principal's stop. The code is reused for
§16.4.1's reason — the client's action is identical. Held mail is **never carried across a stop**:
it bounces at the close, so lifting a stop cannot release stale commands into a fresh run. Senders
see an ordinary bounce; the §16.4 attribution boundary (*"senders cannot distinguish an operator
kill from an addressee crash, **by design**"*) holds because an owner `DELETE` presents identically.

**B8. Capability and version gating (amends §8.0, §10).** `sessions.names: { "enabled": true,
"hold_seconds": 900 }`; absent ⇒ not offered. Following the v0.5 pattern in `capability.schema.json`,
advertising it requires a declared minor ≥ 7; an envelope whose `to` uses the name form MUST declare
`"ma2h_version": "0.7"` or later (the mirror of vector `sv-038`). A sender MUST feature-detect via
§8.0 before first use; B2 and B3 close the deployment-window gap on the submit and registration
sides respectively. The feature rides the existing `inter_agent` account opt-in and sender
allowlists unchanged — a name is a way of addressing a principal the sender could already address.

**B9. Wire delta.** `registerRequest.name` and `session.name`; the `to` pattern on `message` and on
the directive envelope widened to `^agent:[^#]+(#(sess_.+|name:[a-z0-9][a-z0-9._-]{0,62}))?$`;
capability `sessions.names`; one new §8.5 code, `name_in_use` (409). `session_closed_by_operator`
(403), `destination_gone` (410) and `unknown_destination` (422) are reused.

### Delivery-honesty cost (A and B alike)

Holding mail delays the truth about a **dead** destination by the window: a sender to a crashed run
reads `queued` — and an addressed ask stays `open` — for up to the window longer than today before
the bounce. This is not a false belief in §14.2's sense: the ack snapshot says `offline`, the track
never claims `delivered`, and the bounce still arrives with a truthful `prior`. But it is a real
latency cost, and it is why the window MUST be advertised and SHOULD default to the order of one
lease. The options differ in **who pays**: under A, every sender to the session; under B, only
senders that chose the name form. Under Option 0's longer lease, every sender pays the whole TTL.

## Rationale & alternatives

### Weighing A against B from the spec text

| | A — lapse-revival | B — Hub-bound name |
|---|---|---|
| §16.2 closed renewal list / `dp-019`(4) | unchanged | unchanged |
| §16.3 state machine / `dp-019`(5) | **rewritten** (new non-terminal state) | unchanged |
| Session `state` enum seen by pre-0.7 readers | gains a value an old reader cannot interpret | unchanged |
| Address survives a gap longer than the window | **no** — after `lapsed → expired` the id is gone for good | **yes** — the name is re-claimable indefinitely; only the *mail hold* is bounded |
| Operator stop | a fourth state for the close to race; revival must honor the §16.4.1 gate | stop attaches to the name (B7); session machine untouched |
| A pre-feature Hub | client falls back to re-register (works, address lost) | `to` rejected at validation — clean refusal by construction |
| Cached `#sess_…` addresses | keep working | do **not** benefit — senders must adopt the name form |
| New concepts | one state, one request member, two codes | one address form, one binding record, one code |
| What it is, structurally | a second, longer lease with an honest label | the XMPP/SIP split §16 already cites, finished |

The third row is A's hidden cost, and the last row is the argument that decides it. Presence, not
lease state, is what tells a sender whether anyone is listening (§15.2), so a `lapsed` session is
observably an `active` session whose `last_seen` is stale. A therefore buys little that a larger
`sessions.max_ttl_seconds` does not already buy — a better label and a `run_id` check — and it
inherits the same cliff: a step longer than TTL + window still loses the address, permanently. B has
no such cliff. §16's own prior art — *"XMPP bare-JID/full-JID resource binding, SIP REGISTER contact
bindings with `Expires`"* — is a durable name bound to an expiring contact. v0.5 shipped the expiring
contact and left the name out; B adds it. A instead makes the contact expire more slowly.

B also honors the constraint the prior analysis ended on. It adds no renewal source, makes no terminal
mutable, and relaxes no existing MUST. Every sentence of §16.2 and §16.3 stays true as written, and
`dp-019` needs no edit. It is an addition beside the session, not a loosening of it.

A's one real advantage is reach: every address already in circulation is a `#sess_…` address, and A
fixes those without any sender changing. B fixes only senders that adopt the name form. That is a
migration cost, not a design flaw, but it is the reason a steward who wants the smallest change that
moves the measurement might still choose A.

### Recommendation

**Adopt B.** Treat Option 0's longer lease as the complementary, already-available mitigation for
`#sess_…` holders, and do not adopt A: it rewrites the one state machine `dp-019` pins in order to
deliver a bounded version of what the lease clamp already delivers.

**What the steward must decide:**

1. Whether the protocol takes on a third address form at all — or rules address continuity a
   deployment concern (Option 0) and closes this SCP.
2. If B: that an operator stop attaches to the name on cooperative Hubs too (B7). This is new
   normative weight on Hubs that do not advertise `operator_hard_stop`, and B is unsafe without it.
3. If B: the default and bound for `hold_seconds`, accepting the delivery-honesty latency above.
4. If B: Unresolved questions 1 and 3, which change the wire.

### Alternatives rejected

- **A′ — revive an `expired` terminal in place.** Contradicts §16.3 and `dp-019`(5) verbatim, breaks
  the §16.3 marker argument, and must either un-bounce mail (impossible under §7/§14.2) or revive an
  id whose mail is already gone.
- **A sixth renewal source or a heartbeat endpoint.** Closed by the prior analysis; §16.2 refuses the
  heartbeat by name, and it would not help here regardless — an agent that cannot originate a drain
  during a synchronous step cannot originate a heartbeat either.
- **Make `label` the address.** It is free-form, already deployed non-uniquely, and carries characters
  the grammar cannot. Uniqueness cannot be imposed retroactively on a field the spec calls free-form.
- **Client-chosen session ids.** §16.1: *"The Hub **mints** `session.id`."* A client-supplied id
  re-registered after `expired` is A′ under another name.
- **Hold mail at the principal.** Principal addressing is first-claim-wins across siblings (§8.7);
  re-routing a dead session's mail there hands one invocation's commands to an arbitrary other.
- **Per-session derived tokens first.** On the §10 roadmap and complementary (see Security), but they
  authenticate a session; they do not make its address outlive it.

## Backward compatibility

**B — MINOR (0.6 → 0.7), additive.** New `schema/v0.7/` snapshot per house convention, with the B9
changes listed; no existing `$id` changes. A 0.6 agent never claims a name, never sees a name-form
`to` (names are held only by sessions that claimed one), and nothing it does changes. A 0.6 Hub
rejects the name form at validation (B2) and silently ignores `registerRequest.name`, which the
REQUIRED echo check catches (B3). One behavior change to name: on a Hub offering names, an operator
close now also refuses a later claim on the closed session's name (B7).

**A — MINOR by the letter, with one reader-visible change.** `session.schema.json`'s `state` is a
closed enum, and `GET /v1/sessions` carries no reader version, so a 0.6 client validating a listing
that contains a `lapsed` session fails validation. Reporting `lapsed` as `active` to avoid this would
show an `active` session with a past `expires_at`. Neither is comfortable.

**Migration — Hub implementers (B).** A binding table keyed `(account, agent_id, name)`, independent
of session-row retention; entries addressable to a binding as well as a session; the terminal hook
branches on *why* the holder ended (lapse → hold; close → bounce); one new sweep predicate (hold
expiry). Note for implementers: the race in autnmy/oh-hai#902 — an entry inserted after its
session's bounce already ran — has a direct analogue at hold expiry and at B7's close. Settle it
with a sweep predicate over *un-acked entries whose binding is released*, not with the
edge-triggered hook alone.

**Migration — clients (B).** Claim a stable, per-role name at registration; check the echo; publish
the name form once, in place of the session id; on `409 name_in_use`, stop and report rather than
retry (the twin of the existing two-runs-one-session refusal); on `403 session_closed_by_operator`,
the existing stop handling applies unchanged. Senders feature-detect, then prefer the name form
wherever the recipient published one, and keep `#sess_…` where they mean one invocation.

**Related, and not solved by either option:** autnmy/oh-hai#989 asks who may *resolve* a task
addressed to `#sess_A` after the run rolls to `#sess_B`. Under B a task addressed to a name has the
obvious resolver default — the name's current holder — but the `#sess_…` case is a §8.8 resolver
question of its own and is left to that issue.

## Security considerations

**The trust boundary does not move.** Both options operate inside one principal, which §16.5 already
declares one trust domain: *"sessions of the *same* principal share one credential and can therefore
impersonate each other's session address."* A sibling run holding the shared credential can, today,
present another run's **live** session at the drain and read its mail. Everything below is measured
against that baseline rather than against an isolation the protocol does not claim.

- **Spoofing the revival proof (A).** `run_id` is not a secret: it is on every envelope (§4.1), it is
  on the session resource, and it is therefore readable by every sibling (own-session visibility is
  unconditional, §16.4) and, where the listing grant is held, by every agent in the account. §4.1
  already says it *"MUST NOT be used to authorize cross-run access (§9.1)."* The A2 `run_id` check is
  therefore an **accident guard** — it stops two honest runs on one machine from reviving each
  other's session — and MUST be documented as not a security control. A Hub-minted revival secret
  would be a real control, and would also be the protocol's first per-session secret, contradicting
  §16's *"**No new credentials:** … a session id is not a secret and not a credential"*; that belongs
  to the roadmap's per-session derived tokens, not here.
- **Mail theft between sibling runs (B).** After a lapse, any run under the principal may claim an
  unbound-held name and receive its held mail. Within the threat model this grants nothing a sibling
  lacks today. It does widen the *accident* surface — a misconfigured second run claiming the first's
  name — which is why a live holder is never displaced (`409`), why `delivered`-but-unacked entries
  bounce rather than transfer (B5), and why senders needing one invocation keep `#sess_…`. Across
  principals nothing changes: names are scoped to `(account, agent.id)`, and a claim requires that
  principal's credential.
- **Replay.** No signed context changes. A name-addressed entry is re-signed per delivery with a fresh
  `t`/`jti` like every other (§9.8); `to` is bound, so an entry signed for one name cannot be
  replayed at another, and the B4 recipient check stops a validly-signed entry for a name the
  recipient no longer holds from being acted on.
- **Kill-switch evasion.** A: a revival MUST lose the CAS to a concurrent operator close and MUST
  honor the §16.4.1 gate *"on the same read that authenticates the request."* B: closed by B7 —
  without it, B would make the cooperative kill strictly weaker than it is today. This is the finding
  most likely to be missed in implementation and should carry its own vector.
- **Oracles.** Names are guessable where session ids are not, so `202` vs `422` on a name-addressed
  submit reveals that a role exists — within the sender's own account, to a sender already permitted
  to address that principal, which is exactly what principal addressing reveals today. The §4
  collapse rule and the §8.0 allowlist-reads-as-unknown rule apply to the name form unchanged; hold,
  stop, and owner-close present identically to senders.
- **Resource bounds.** Bindings are bounded by `max_live_per_agent` plus the hold window; held mail
  by the existing mailbox depth cap (§8.6) and the hold. A: `lapsed` sessions count against the cap.
- **Privacy.** A name is operator-chosen text visible wherever the session is (§16.4). It SHOULD name
  a role, not a person; it is otherwise no more revealing than `label`.

## Conformance

Vectors that would be needed — listed, not written.

**B — schema-validation:** name-form `to` valid on `v0.7/message` and on the directive envelope;
name-form `to` **invalid** against `v0.6/message.schema.json` (pins the clean-refusal property B2
depends on); name-form `to` at a declared minor < 7 invalid; `name` charset and length (uppercase,
`#`, `:`, empty, over-length invalid); session resource with `name`; capability with
`sessions.names`; `sessions.names` advertised at minor < 7 invalid.
**B — downstream proofs:** (1) claim, lapse, re-register with the same name: a send to the name form
before, during, and after the gap is delivered, and none bounces; (2) a second live claimant →
`409 name_in_use`, and no session is minted; (3) a `201` without `name` is treated by a conformant
client as not bound; (4) hold expiry bounces `prior: "queued"`, auto-resolves `system:undeliverable`,
and the receipt's `session` names the last holder; (5) `delivered`-but-unacked name-addressed entries
bounce at lapse and are **not** redelivered to the next holder; (6) owner `DELETE` bounces at once
with no hold; (7) **operator close places the name under the stop** — a re-claim is refused
`403 session_closed_by_operator`, held mail bounces at the close, and lifting a hard stop releases no
held mail; (8) a sender cannot distinguish hold-expiry, owner-close and operator-close; (9)
session-addressed mail to the lapsed holder still bounces exactly per `dp-022`; (10) §13.4 step 2
refuses a validly-signed entry for a name the recipient's current session does not hold; (11) no
cross-principal claim or resolution of a name; (12) the entry racing the release is settled (the
autnmy/oh-hai#902 class).

**A — would need:** `dp-019`(5) reworded; schema vectors for `state: "lapsed"` and `revive`;
downstream proofs for revival by the same `run_id` within the window (same id), `run_id` mismatch →
`409` with no session minted, revival after the window refused, `closed` never revivable from any
state, revival racing an operator close, mail held across `lapsed` and bounced on `lapsed → expired`,
`lapsed` never `online`, `lapsed` counting toward the cap, and the `session_lapsed` → `gone` fallback.

## Reference implementation

None yet; a design document without code cannot reach Accepted, and none is claimed. On a ruling, the
linked PR grows `reference/src/hub.ts` (the binding record, name-form routing, the hold sweep, B7) and
the conformant-client layer (claim, echo check, `name_in_use` handling). First production
implementation would be the Hub that produced the measurement (autnmy/oh-hai#1170).

## Unresolved questions

1. **How does a name propagate to a replier?** §16.4's discovery path is the Hub-attested `from`,
   which stays session-qualified under B — so a recipient replying to `from` still uses the unstable
   form. Attesting the name needs either a new bound field (a new §9.8 context — the old one is a
   fixed key set) or a change to what `from` carries (`inbound-message.schema.json` pins
   `^agent:[^#]+#sess_.+$` when `agent.session` is present, and recipient sender policies may be
   pinned to the session form). This draft keeps `from` unchanged and relies on the session
   resource's `name`; the steward should rule whether that is enough for v0.7.
2. **Should an owner `DELETE` be able to keep the name held** (a graceful supervisor restart), rather
   than always releasing it and bouncing?
3. **`delivered`-but-unacked entries at lapse (B5):** bounce (this draft — safe against double
   execution by a different run) or re-queue for the next holder (the §8.7 precedent for
   principal-addressed rescue)? A `run_id`-equality rule could split the difference, at the cost of
   leaning on `run_id` again.
4. **One name per session, or several?**
5. **Should the addressed ack tell the sender its mail is being held** (a `destination` member beyond
   `offline`), and under which visibility rule?
6. **MAY or SHOULD** for a Hub offering `inter_agent` to also offer names.
7. **Does the name stop (B7) need a human-facing listing**, or does §16.4.1's stop surface cover it?

## Future possibilities

- **Per-session derived tokens** (§10 roadmap) would turn the same-principal caveat into a boundary,
  and could then bind a name to a token rather than to a principal.
- **Name-scoped sender allowlists and resolver defaults** — a name is a natural unit for both, and
  for the scoped role grants the roadmap already lists.
- **Queue groups** — several live holders of one name, load-balanced — are the roadmap's
  principal-addressed item restated at name granularity, and need no further wire change.
