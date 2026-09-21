# SCP: MA2H v0.7 — a pushed signal that is not a failure (the `unread` and `acknowledged` receipts)

> Draft for SCP issue #TBD — not yet filed, not yet sponsored. Drafted against
> [`spec/v0.6.md`](../../spec/v0.6.md), `schema/v0.6/`, the reference implementation, and the published
> vectors `dp-019`, `dp-020`, `dp-021`, `dp-022`. This document proposes and compares; it changes no
> spec text, no schema, and no vector. The `v0.7` in the file name is the minor this would ship in if
> accepted as written (additive, MINOR); it is provisional until the steward rules. A sibling draft,
> SCP #69 (*an address that survives a lease lapse*), targets the same minor; the two are independent
> and their one point of contact is named under *The remainder* below.

## Preamble
- **Author(s):** Tim Layton (drafted with Claude)
- **Status:** Draft
- **Type:** Standards Track (normative)
- **Created:** 2026-09-21
- **SCP issue:** #TBD
- **Linked PR:** — (document PR #TBD; an implementation PR follows a ruling on the Recommendation)
- **Scope:** Option B touches §8.0, §8.1, §8.7.1, §9.8 (the receipt digest's *inputs*, not its key
  set), §13.4, §14.2, §16.1 and `dp-022`. Option A touches the same sections plus §4 (one envelope
  field) and `dp-020` obligation (9). The ack definition (§13.4 step 4, §14.2) is a normative
  clarification both options depend on. No signed context gains or loses a key (§9.7, §9.8); the
  §16.3 state machine and `dp-019` are untouched.
- **Related (first implementation's tracker):** autnmy/oh-hai#1171 (the measurement), autnmy/oh-hai#1173
  (a lease that renews with no reader; its items 2–4 fold in here), autnmy/oh-hai PR #1177 (the
  no-protocol-change baseline), autnmy/oh-hai PR #1181 (`last_acted_at`), autnmy/oh-hai#986
  (`--wait-delivered`), autnmy/oh-hai#1090 (`messages get <id>`), autnmy/oh-hai#975 (an ack that
  matched nothing), autnmy/oh-hai#902 (mail inserted after the bounce), autnmy/oh-hai#655 (the
  human-facing twin of this problem).

## Abstract

v0.5 gave a sender one truthful ladder (§14.2): reachability at send, then `delivered` /
`acknowledged`, or the terminals `bounced` / `expired`. Every rung is readable on the sender's §8.2
pull. Exactly one rung is **pushed**: the bounce, as a `receipt` entry (§8.7.1) whose `event` enum
has the single member `bounced`. A sender that does not poll every message id therefore hears from
the Hub only when a send has failed, and reads the absence of that signal as success — because no
other reading lets work continue.

This SCP compares three answers. **0** — no protocol change: poll, and let the Hub make a dead
mailbox lapse sooner. **A** — a positive receipt, `event: "acknowledged"`, requested per message.
**B** — a pushed advisory, `event: "unread"`, emitted once when an addressed entry has gone
unacknowledged past a Hub-advertised bound. It also rules on a *read-by-the-agent* signal (rejected,
with reasons), pins what `acknowledged` means (custody, not action), and disposes of the three
protocol items left open by autnmy/oh-hai#1173.

It recommends **B, with a correction rule that brings `acknowledged` onto the wire, and A's
per-message request in the same minor**. One finding shapes everything: a new receipt event cannot
be default-on, because a conformant pre-0.7 consumer treats it as a verification failure.

## Motivation

### The mechanism

- §14.2: *"Senders learn of a bounce via their §8.2 pull (authoritative) and — when
  session-registered — a `receipt` entry (§8.7), so an open bridge learns immediately."* Nothing
  equivalent exists for any other rung.
- §14.2: a delivery-track `expired` *"emits **no receipt** in v0.5 (`receipt.event` carries only
  `bounced`; the sender's §8.2 pull is authoritative for expiry)."*
- `schema/v0.6/inbound-message.schema.json#/$defs/receipt`: `"event": { "enum": ["bounced"] }`, with
  the description *"`bounced` in v0.5; future minors may add events."*
- §14.2 closes with the invariant this SCP measures the protocol against: *"At no point can "it's
  fine" and "nobody will ever see this" present identically."* On the **pull** surface that holds.
  On the **push** surface, "it's fine", "nobody has read it yet" and "nobody ever will, but the lease
  is still renewing" all present identically: as silence.

§10's roadmap already names the gap: *"richer `receipt` events (delivery, read)."* This is that item,
with a measurement.

### The measurement

From the first production implementation (autnmy/oh-hai#1171), as written there: one night, one
account, about 20 long-running agents; quotes are from the operator's running ledger (UTC,
2026-09-20 → 09-21).

- **03:40Z** — *"dark ~8 h, 36 messages acked-but-unread … "attended + acked + caught up" does not
  mean an agent read it (… acked 36 and read none)"*. 36 sends, 36 `acknowledged`, zero read.
- **01:2xZ** — *"CONSUMER DEAD (… 3 snapshots "consumer DEAD · 10 unread"; my 01:16Z and 01:21Z sends
  still queued/unacked; lease active, last_seen 01:20Z)."* The bounce came at 01:35:15Z. About 19
  minutes with no signal, and then the only signal was the failure. Two of the ten were review
  verdicts.
- **02:3xZ** — *"a DEAD MAILBOX (lease active, consumer dead, 154 unread; every send since ~01:0xZ
  landed there unread) … Found only via doctor --self-test after a 30-min monitor with zero events."*
  About 2 hours, 154 messages, zero signals to any sender.
- **20:2xZ** — the shipped poll doing its job when someone thought to use it: a `--wait-delivered`
  probe *"stayed QUEUED with no bounce = session alive, NO READER"*.

From the agents' own notes that night: *"Both ack `queued` at SEND time, so they are
indistinguishable when you send them."* and *"a bounce is a SIGNAL and silence is not."* The
operator's working rule is a workaround for the gap: post the result on a durable object first and
treat the message as a notification only — *"`queued` plus silence is not delivery."*

The measurement contains **two** gaps, and they need different answers. Gap 1 is the missing pushed
signal (the 19-minute and 2-hour silences). Gap 2 is that `acknowledged` was true and useless (the 36
messages): the ack in that client is a *read-through* ack — the consumer acks what its local reader's
cursor has passed — which the client's own source describes as *"A CONSUMER READ THE BYTES, never
that the model acted on them."*

### Why it is general

Any sender that acts on the belief that its message arrived meets gap 1: an agent handing off work, a
coordinator fanning out, a peer reporting a review verdict. Polling cures it only for senders that
hold state per message id and poll every one; a design whose only pushed signal is negative is read
as positive whenever the signal is absent. Gap 2 is general for a structural reason: the party that
acks (a transport client) and the party the sender cares about (an agent, often a model between
turns) are different things, and only the first is visible to a Hub.

## Specification

Normative wording is a sketch at the precision needed to compare the options; final text lands with
the implementation PR for whichever the steward accepts.

### The constraint every option inherits: a new event cannot be default-on

§8.7.1: *"a consuming agent MUST validate shape before acting"*; §13.4 gives `receipt` entries the
duties *"signature verification (§9.8), dedup … and ack."* The v0.5/v0.6 receipt schema has a closed
`event` enum and lists `prior` and `session` as `required`. A conformant pre-0.7 consumer handed
`event: "unread"` therefore **fails shape validation**, and shape is part of the verification step:
the reference client classifies it `fatal-verification` (`reference/src/client.ts`, `receiveReceipt`)
and the reference bridge loop exits on that disposition (`reference/src/agent.ts` — *"means tampering
or a broken Hub, never something to skip past"*). That is correct behavior and must stay so.

So a Hub MUST NOT deliver a post-0.6 receipt event to a session that has not declared it. The
declaration belongs to the **session**, not to the message: the party that parses a receipt is
whoever drains the sender's session, and §16.5 records that *"sessions of the *same* principal share
one credential"* — a submit may name `agent.session` from a process other than the one draining it.
A per-message field set by a new submitter would deliver an unparseable entry to an old drainer. A
per-message field is a *volume* control; only the registration is a *safety* control.

**S1. Session declaration (amends §16.1).** `POST /v1/sessions` gains an optional
**`receipt_events`**: an array of event names the session's consumer can verify and consents to
receive. `bounced` is implicit and need not be listed. A declaration containing `unread` MUST also
contain `acknowledged` (B3 below). The `201` echoes the accepted set on the session resource.
**The echo is the feature detector (client MUST):** `registerRequest` is an open object and §10
requires a Hub to *"ignore unknown fields"*, so a pre-0.7 Hub accepts the member and returns a
session without it; a client MUST read a `201` lacking `receipt_events` as *nothing beyond `bounced`
will be pushed*. This is §8.1's misroute-detector pattern applied to registration.

**S2. Capability (amends §8.0).** `inter_agent` gains **`receipt_events`** (the events this Hub can
emit, e.g. `["bounced", "unread", "acknowledged"]`; absent ⇒ `["bounced"]`) and, when `unread` is
listed, the REQUIRED **`unread_after_seconds`** (B1). Following the v0.5 pattern in
`capability.schema.json`, advertising either requires a declared minor ≥ 7, and a receipt carrying a
post-0.6 event MUST declare `"ma2h_version": "0.7"` or later (the mirror of vector `sv-038`).

**S3. The receipt body and its digest (amends §8.7.1, §9.8 — no key-set change).** §9.8 already
provides for this: the digest is over six fixed keys *"where any absent member serializes as JSON
`null` (all six are present in a v0.5 bounce receipt; the `null` convention … keeps the digest
unambiguous as future minors add events)."* The new events use exactly those six keys:

| `event` | terminal? | `prior` | `session` | `at` |
|---------|-----------|---------|-----------|------|
| `bounced` (unchanged) | yes | REQUIRED | REQUIRED — the terminal destination session | the bounce |
| `unread` | **no — advisory** | REQUIRED: `queued` (never drained) or `delivered` (drained, not acked) at the moment the bound passed | present iff the message was session-addressed, and then equal to the session segment of the sender's own `to`; otherwise absent (`null` in the digest) | the moment the bound passed |
| `acknowledged` | yes | MUST be absent (`null`) | as for `unread` | the track's `acknowledged_at` |

`prior` keeps its meaning — the delivery-track state the event fired *from* — generalized from "the
state the entry bounced from". `session` deliberately carries nothing the sender did not write: for a
principal-addressed message the claimant's session id is **not** disclosed on the new events. The
v0.7 schema moves `prior`/`session` from the receipt's flat `required` list into per-event
conditionals. `event` is inside the digest, so rewriting `unread` into `acknowledged` breaks the
signature, as `dp-017` already proves for `prior`. The ack's free-text `note` (§14.1) is **not**
carried: the six-key wrapper has no slot for it, and §16.4 already states why an unsigned field on a
receipt is unacceptable (*"an attribution field there would be unsigned and injectable, and extending
the digest is a signature break"*). A sender that wants the note pulls (§8.2).

**S4. Invariants that carry over unchanged.** Receipts remain *"best-effort,
at-most-once-meaningful"*, deduplicated on `(in_reply_to, event)`, delivered *"only to **live
sessions of the sender**"*, and *"MUST NOT themselves generate receipts"* (§8.7.1); the §8.2 pull
remains authoritative. A sender that named no `agent.session` has no return address and gets no
receipt of any kind — as today (`reference/src/hub.ts`, `emitBounceReceipt`: *"A sender that named no
session (or whose session is itself terminal) gets nothing"*; the first implementation's
`delivery-honesty.ts` makes the same check). Receipts go to the **submitting session only**; no
option lets a sender name a different recipient for them (Security).

### The ack means custody (normative clarification; both A and B depend on it)

The spec currently says two things. §14 and §14.1 describe the ack as *"a one-shot, **terminal**
confirmation that the receiving party got the other party's message"* — *"got it, on it."* §13.4
step 4 says the agent acks *"once it has **durably processed** the directive, so the Hub stops
redelivering it"*, inside an ordering that reads *"act (durably/idempotently) → record the `id` … →
ack"*. For a program that consumes a directive synchronously these coincide. For a bridge in front of
a model they cannot: a model turn may be hours away, the visibility window is advertised in seconds
(`inbound.visibility_timeout_seconds`, 60 in §8.0's example), and §14.2 bounces
delivered-but-unacked mail when the session dies. A client that waited for "the agent acted" would
turn every slow turn into redelivery and every restart into a bounce of mail that was safely held.

Proposed text (§13.4 step 4, §14.2 `acknowledged`): **an ack is a custody transfer.** The acking
client asserts that it has verified the entry and durably taken responsibility for presenting it to
the agent, so that Hub redelivery is no longer needed. It asserts **nothing** about whether the
agent — a model, a human-in-the-loop runtime, a program — has seen or acted on the content, and a
Hub, a sender, or a product surface MUST NOT present `acknowledged` as "read" or "done". Two client
duties follow: a client MUST NOT ack a command entry it has no means of presenting (custody requires
a custodian); and a client that has evidence no agent-facing reader is attending SHOULD stop acking
command entries rather than accumulate custody it cannot discharge. The first implementation's
client-side unattended bound (autnmy/oh-hai#909) is the second duty already; the 36-message case is
the first duty not yet met. Under this definition a client that *holds* its ack until the
agent-facing reader has taken the entry is conformant, and under Option B its senders get
`unread` with `prior: "delivered"` — gap 2 converted into a signal without any new claim about
reading.

### Option 0 — no protocol change

Two levers exist, both shipped in the first implementation:

1. **Poll.** The §8.2 `mailbox` object is *"the **sender's authoritative view of the outbound mailbox
   track**"*. The reference CLI wraps it as `--wait-delivered` (autnmy/oh-hai#986; exit `7` =
   accepted, not yet acknowledged) and `messages get <id>` (autnmy/oh-hai#1090).
2. **Make a dead mailbox lapse.** autnmy/oh-hai PR #1177: the Hub withholds lease renewal from a
   session holding unread command mail older than 900 s with no evidence of reading for 900 s, so the
   lease lapses and the **existing** §14.2 bounce fires. §16.2 and `dp-019` obligation (4) say a
   lease is renewed *"ONLY by"* the listed activity; they restrict what may renew and do not oblige a
   Hub to extend on every touch, so this needs no spec change (made explicit under *The remainder*).

**This is the baseline, and it is a real improvement:** the 2-hour dead mailbox now ends in a bounce.
**What remains unsolved after it:** the sender still hears nothing until the lapse — up to N plus one
TTL after the mail went stale, 30 minutes at the defaults and longer where a client asked for a
longer lease — and the signal, when it comes, is still the failure. Nothing positive is ever pushed.
Only senders that block or poll per message id learn anything sooner; a fire-and-forget agent, a
coordinator with a hundred sends in flight, and any sender whose process does not survive to poll
learn nothing until a bounce. Principal-addressed mail does not bounce on a session's death at all
(§14.2), so for it the first pushed signal is none, ever — its only terminal short of an ack is a
retention-end `expired`, which emits no receipt. And gap 2 is untouched.

Option 0 is the right answer if the steward judges push-side honesty a product concern. Its cost is
that the operator's workaround — *do not trust the channel* — stays the correct advice.

### Option B — a pushed "still unread" advisory

**B1. The bound.** A Hub offering `unread` advertises `inter_agent.unread_after_seconds` (`U`). `U`
MUST exceed `inbound.visibility_timeout_seconds` (a healthy consumer mid-processing must not trip
it) and SHOULD NOT exceed the smallest lease the Hub grants (so the advisory precedes a lapse
bounce). It is a Hub-wide constant in this draft (Unresolved question 2).

**B2. Emission (amends §14.2).** For an addressed `message` entry — any verb, session- or
principal-addressed — whose submitting session declared `unread` (S1): when `U` has elapsed since
accept and the mailbox track is still **non-terminal** (`queued` or `delivered`) and, for an
`ask`/`task`, the §7 resolution is still open, the Hub emits **one** `unread` receipt, with `prior`
set to the track state at that moment. No liveness test on the destination is needed or wanted: a
session-addressed entry whose session died has already bounced (terminal, so ineligible), and asking
"is the destination live?" would add a presence read to a path that needs none.

- **Exactly once across replicas.** The obligation is *at most once per entry*. The mechanism is the
  one §7 already uses: a single atomic compare-and-set on the entry record (stamp "unread notified"
  where unset **and** the track is non-terminal **and** age > `U`); the replica that wins the CAS
  emits, every other replica's sweep finds the stamp. The recipient's `(in_reply_to, event)` dedup is
  the backstop, not the mechanism.
- **Advisory, not terminal.** `unread` changes no track and no §7 state. The entry may be
  acknowledged a second later. §9.8's *"Receipts drive **no** action"* is kept by stating what a
  sender may do with it: a sender MUST NOT treat `unread` as failure. It MAY escalate, use another
  channel, or (for an `ask`) cancel via §8.4 and re-issue. It SHOULD NOT blindly re-send: the
  original is still queued and at-least-once delivery means both copies can be acted on.
- **Ordering.** Per entry the only possible receipt sequences are `[unread]? → (acknowledged |
  bounced)?`. A Hub MUST NOT emit `unread` once the track is terminal (the CAS condition guarantees
  it). Mailbox redelivery MAY reorder (§8.7), so a consumer MUST ignore an `unread` for an
  `in_reply_to` for which it has already accepted a terminal receipt.

**B3. The correction rule.** An advisory that is never corrected becomes a false belief in the other
direction: the sender is told "unread", the entry is acked a minute later, and — absent Option A —
nothing says so. Therefore: **if the Hub emitted `unread` for an entry and that entry's track later
reaches `acknowledged`, the Hub MUST emit an `acknowledged` receipt**, whether or not the sender asked
for one. The other terminal, `bounced`, is already pushed. This is why S1 requires `acknowledged`
alongside `unread`, and why B cannot ship without the `acknowledged` event on the wire even if A's
per-message request is deferred. The cost is bounded: at most one extra receipt, and only for entries
that actually went unread.

**B4. Interaction with a #1177-style lapse.** The timeline for a session whose reader died while its
renewer lived: `t₀` send → `t₀+U` `unread` (`prior: "queued"`) → renewal withheld once the mail and
the last read are both older than N → lease lapses within one TTL → `bounced` (`prior: "queued"`),
with the §7 auto-resolution. An advisory followed by a terminal; nothing in §14.2 is contradicted.
Against the measurement, with `U` = 900 s as autnmy/oh-hai#1171 proposes: the 2-hour silence becomes
a signal at minute 15 for each of the 154 sends. The 19-minute case improves less than it sounds —
the 01:16Z send would have drawn `unread` at 01:31Z, four minutes before the bounce, and the 01:21Z
send would have bounced first. A shorter `U` is what moves that case, which is the argument for
leaving `U` to the Hub and advertising it rather than tying it to the lease.

**B5. Wire delta.** `registerRequest.receipt_events` / `session.receipt_events`; receipt `event` enum
gains `unread` and `acknowledged` with per-event `prior`/`session` conditionals; capability
`inter_agent.receipt_events` and `inter_agent.unread_after_seconds`. No new §8.5 error code, no new
endpoint, no new signed context, no new track state.

### Option A — a positive receipt, requested per message

**A1. The request (amends §4, §8.7.1).** The envelope gains an optional top-level **`receipts`**: an
array of event names the sender requests *for this message*. In this draft the only requestable
member is `acknowledged`. Absent `receipts` means the Hub default — `unread` (with its correction)
if the submitting session declared it, nothing otherwise; `"receipts": []` means nothing beyond
`bounced` for this message. An unknown member → `422 invalid_field` (existing code). `receipts` is
meaningful only with `to`; on a human-inbox message it MUST be ignored.

`receipts` is **submitter-side machinery**, in the class §8.7.1 already strips: the Hub MUST remove
it before delivery, alongside `state`, `client_ref` and the callbacks (`dp-020` obligation (9) gains
one name). It is therefore **outside every signed context** by construction: submits are not signed
(they are authenticated, §9.1); `message_signed_context.payload_sha256` binds *"exactly the delivered
envelope's **present** fields among"* a closed list that does not include it; and the addressee never
sees it, so it cannot condition the addressee's behavior on whether the sender is watching. For §8.1
idempotency it is ordinary payload: a same-key replay with a different `receipts` is a `409`, and the
first submit's value stands.

**A2. The effective set, echoed (amends §8.1).** The Hub computes `requested ∩ declared-by-session ∩
offered-by-Hub`. The addressed `202` carries **`receipts`**: the events the Hub has committed to
attempt for this message. A sender MUST read an absent member as *none will be pushed*. This covers
the three silent degradations at once: a pre-0.7 Hub (ignores the field, echoes nothing), a session
that did not declare the event, and a sender with no session (no return address — S4).

**A3. Emission and ordering (amends §14.2).** When the mailbox track reaches `acknowledged` for a
message whose effective set contains it, the Hub emits one `acknowledged` receipt. The brief's
ordering worry is already closed by v0.6 text: §14.2 makes `acknowledged` *"Terminal for this
track"*, and the bounce covers only *"every un-acked session-addressed COMMAND entry"* — so
`acknowledged` and `bounced` are the two outcomes of one first-terminal-wins CAS, and an
`acknowledged` receipt followed by a bounce for the same entry is impossible, not merely undefined.
A Hub MUST emit the terminal receipt from the transition that won the CAS and from nowhere else.

**A4. No `delivered` event.** Considered and left out. `delivered` is stamped at first drain; with a
read-through client it precedes `acknowledged` by milliseconds and doubles the volume for no
information. The case where it *is* informative — drained and never acked — is exactly `unread` with
`prior: "delivered"`, which costs nothing when things go well.

**A5. Volume.** One receipt per opted-in message, delivered into the sender's own mailbox, which the
sender must drain and ack. For a coordinator that is a doubling of its inbound entries, which is why
A is per-message and off by default. Receipts count against the sender's own mailbox depth cap
(§8.6); a receipt that would exceed it is dropped, not queued elsewhere (best-effort, §8.7.1).

**A6. Wire delta.** Everything in B5, plus envelope `receipts` and submit-ack `receipts`.

### A "read by the agent" signal — analysed, and rejected for this minor

The sender's real question is whether the agent saw the message. Three candidate signals:

1. **A Hub-observed read.** Impossible. A Hub observes transport calls. It cannot observe a model
   turn, a context window, or a process handing bytes to another process. Any such state would be the
   optimistic reporting §15.1 bans (*"MUST NOT advance a mailbox entry's delivery track absent
   client-originated receipt evidence"*), one layer up.
2. **An explicit agent-level marker, distinct from the transport ack** — a second, later assertion
   ("presented to the agent"), the shape of XMPP's XEP-0333 `displayed` beside XEP-0184's `received`,
   or email's MDN (RFC 8098) beside the DSN (RFC 3461). It is *possible*, and honest as far as it
   goes, but it is asserted by the same client layer whose ack just proved uninformative, and a Hub
   cannot verify it. The prior art is discouraging on exactly this point: MDNs are optional,
   unverifiable, and widely ignored. It would also need a new track state after a state §14.2 calls
   terminal, and a seventh digest key or a second receipt shape. **Not recommended now**; recorded
   under Future possibilities with the conditions that would change the answer.
3. **The agent's next submit.** The reference Hub's `last_acted_at` (autnmy/oh-hai PR #1181) is a
   Hub-layered, non-spec session field that moves only on an accepted submit carrying
   `agent.session` or a §8.8 resolve presenting it — never on a drain, an ack, a stream connect or a
   renewal. It is the cheapest honest proxy for "the agent itself did something", and it is derived
   the way §15.1 likes (*"no new agent obligation"*). It is also a heuristic with known failure
   modes in both directions (a supervisor script that sends on the agent's behalf moves it; an agent
   that reads and rightly says nothing looks idle), it is per-session rather than per-message, and
   it is readable only under §16.4's listing rules, which most senders do not hold. **Leave it
   Hub-specific.** Nothing blocks that: the session resource is an open object and §10 has readers
   ignore unknown members. If a second implementation wants the same signal, standardize it then as
   an OPTIONAL §15.1 derivation, not before.

**The protocol already has the per-message form of this signal, and it is a verb.** An addressed
`ask` that comes back `answered` is proof that something on the other side read it and replied; §7's
resolution is attested and signed. A sender that needs to *know* should send an `ask` (`confirm`
mode is one click for a human and one call for an agent), not a `notify` plus a hoped-for marker. The
spec should say so in §5.1, and the custody definition above should stop anyone reading
`acknowledged` as more than it is. That, plus `unread`, is the honest answer to gap 2: the protocol
says less, truthfully, and gives the sender a stronger verb for when it needs more.

### The remainder of autnmy/oh-hai#1173 (items 2–4)

- **Item 2 — a named non-active session state ("leased but unread"): not needed now.** `state` is a
  closed enum in `session.schema.json`, `GET /v1/sessions` carries no reader version, and a pre-0.7
  client validating a listing that contains a new value fails validation — the same cost SCP #69
  identified for a `lapsed` state. The condition is also *derived* (unread count and age), short-lived
  under a #1177-style rule (at most N plus one TTL before it becomes `expired`), and of interest to
  two audiences already served elsewhere: senders, per message, by `unread`; operators, by
  Hub-layered fields on an open resource. Two small clarifications are proposed instead, both
  separable from A and B: (i) §16.2 states outright that the renewal list is a ceiling — a Hub MAY
  decline to extend a lease on a touchpoint that is not evidence of consumption; (ii) §15.1's
  addressed-message reachability counts only activity that shows the session *can claim an entry*
  (registration, a drain, a stream connect or reconnect, a consuming ack). §15.1 already defines
  `online` there as *"a live session exists that could actually claim the entry"*, yet lists *"a
  submit naming the session"* as qualifying activity; a session that only sends is the
  online-but-undeliverable belief `dp-021` obligation (7) bans, and the §8.1 `destination` snapshot
  is where a sender would otherwise see the truth at send time. (ii) is a tightening and is called
  out as such under Backward compatibility.
- **Item 3 — a receipt to senders:** Option B. #1173's event name `unattended` is not adopted: it
  describes the destination's state, which the Hub cannot know and the sender may not be entitled to;
  `unread` describes the sender's own entry, which the sender can already pull.
- **Item 4 — move, not bounce, mail when the same run registers a replacement session: rejected
  here.** A session-addressed entry's `to` is inside its signed context, and §13.4 has the recipient
  refuse *"a validly-signed entry for a prior session of the same principal"*; "the same run" can
  only mean `run_id` equality, which §4.1 says *"MUST NOT be used to authorize cross-run access"*;
  and moving a delivered-but-unacked command to a successor invites double execution. Mail that
  should follow a role across registrations is what SCP #69's Hub-bound name is for. The half of
  item 4 that needs no protocol change is a client duty worth writing into §16.1: a client that
  registers a replacement SHOULD `DELETE` the session it replaces (own-session visibility is
  unconditional, §16.4, for exactly this), so its mail bounces at once instead of piling up under a
  lease something else is renewing.

## Rationale & alternatives

### Weighing 0, A and B from the spec text

| | 0 — poll + lapse | A — `acknowledged` on request | B — `unread` + correction |
|---|---|---|---|
| Who learns something without polling | nobody, until a bounce | senders that opted in, when it goes **well** | every declaring sender, when it goes **badly** |
| The 2-hour / 154-message silence | bounce after N + TTL | silence (absence of a receipt is the only cue) | `unread` at `U` for each send |
| The 36 acked-unread messages | no help | **makes it worse** unless the ack is defined as custody: 36 positive receipts | no help alone; with a custody-holding client, `unread (prior: delivered)` |
| Receipts when all is well | 0 | 1 per opted-in message | 0 |
| Principal-addressed mail (never bounces on session death) | silent until retention | covered | covered |
| Fits the six-key §9.8 digest | — | yes | yes |
| New track state / endpoint / signed context | none | none | none |
| Safe toward a pre-0.7 consumer | — | only with S1 | only with S1 |

B is the option that answers the measurement: both measured silences are cases where something was
wrong and nothing said so, and B is silent exactly when nothing is wrong. A answers a different
need — a sender that wants closure on a specific important send without holding a poll open — and
A *alone* leaves the sender inferring trouble from the absence of a receipt, which is the very habit
this SCP exists to end. The two do not compete for wire: B3 already requires the `acknowledged`
event, so A adds one envelope field and one ack member.

### Recommendation

**Adopt B, including the correction rule (B3), the session declaration (S1) and the custody
definition of the ack; adopt A's per-message `receipts` request in the same minor.** If the steward
prefers to stage the work, B with its correction ships first and the envelope field second — never A
first, because a positive-only receipt trains senders to read silence again. **Reject a protocol
"read" signal for this minor, leave `last_acted_at` Hub-specific, and decline #1173's new session
state and mail-move in favor of the two §15.1/§16.2 clarifications and SCP #69.**

**What the steward must decide:**

1. Whether push-side honesty belongs in the protocol at all, or is a product concern (Option 0).
2. That `acknowledged` is pinned as custody. This is the one change here that constrains existing
   prose rather than adding to it, and A is harmful without it.
3. That new receipt events are gated on a **session** declaration — accepting that B is therefore
   opt-in for clients, not default-on, and that an un-upgraded sender gains nothing.
4. `U`: its default, and whether it is Hub-wide or per-message (Unresolved question 2).

### Alternatives rejected

- **Default-on `unread` for every session-registered sender.** Cheapest for adopters and unsafe: it
  hands conformant pre-0.7 consumers an entry they are required to treat as a verification failure.
- **A new entry kind (`status`) instead of new `receipt` events.** `inter_agent.entry_kinds` exists
  to gate kinds, so it would be safe — and it would need a fourth §9.8 context, a fourth consumer
  path, and a second way to say what `receipt` was designed to say. The schema's own words are
  *"future minors may add events."*
- **Rename the state senders see (`spooled` / `collected`).** autnmy/oh-hai#1171's alternative for
  gap 2. `acknowledged` is a published state in `get-message.schema.json` and
  `submit-ack.schema.json`; renaming it is a MAJOR change that buys what one paragraph of
  definition buys.
- **Require clients to ack only after the agent acts.** Collides with the visibility window and the
  delivered-but-unacked bounce, as argued under *The ack means custody*.
- **A receipt for `expired`.** Reasonable and small, but it touches a sentence `dp-022` obligation
  (5) pins (*"Delivery-track expiry emits NO receipt in v0.5"*) and none of the measurement needs it.
  Left as Unresolved question 4.
- **Receipts to a sender-named third session** (so a supervisor can watch). A reflection primitive;
  see Security.
- **Refusing or re-statusing new sends to a stale session (#1173 item 3, second half).** A submit
  status other than `queued`/`open` breaks §8.1's replay rule and is a session-state oracle for
  senders §16.4 denies; the `destination` snapshot, made honest by clarification (ii), is the
  existing channel for it.

## Backward compatibility

**MINOR (0.6 → 0.7), additive.** New `schema/v0.7/` snapshot per house convention; no existing `$id`
changes. Changed files: `inbound-message.schema.json` (receipt `event` enum; `prior`/`session` become
per-event conditionals; post-0.6 events require a declared minor ≥ 7), `session.schema.json`
(`receipt_events` on the resource and on `registerRequest`), `capability.schema.json`
(`inter_agent.receipt_events`, `unread_after_seconds`, the minor-≥-7 conditional),
`message.schema.json` and `submit-ack.schema.json` (`receipts`; Option A only).

- **A pre-0.7 consumer** never declares an event, so it never receives one. Its bounce receipts are
  byte-for-byte unchanged, including the digest.
- **A pre-0.7 Hub** ignores `registerRequest.receipt_events` and the envelope's `receipts` (§10); the
  S1 and A2 echo checks turn both into a visible "not offered" rather than a silent one.
- **Rolling deploys.** A replica that predates the feature emits nothing; receipts are best-effort,
  so this degrades to today's behavior. A replica that predates the *stamp* in B2 could double-emit
  only if it emitted at all, which it does not.
- **Behavior changes to name.** (1) The custody definition constrains how products may *describe*
  `acknowledged`; it changes no wire behavior and makes no conformant client non-conformant, but a
  client that acks entries it cannot present is newly out of step with a MUST NOT. (2) Clarification
  (ii) can turn a `destination.state` of `online` into `offline` for a session that only sends. That
  is a tightening of a truthfulness rule in the direction §15.1 already points, and no sender may
  rely on `online` as a promise (§15: *"a heuristic, not a guarantee"*).

**Migration — Hub implementers.** One nullable stamp per entry and one sweep predicate for B2; one
emission hook on the existing ack transition for A3/B3; the declared set stored on the session row.
The race in autnmy/oh-hai#902 (an entry inserted after its session's bounce already ran) has an
analogue: such an entry sits `queued` against a terminal session and would draw an `unread`. That is
the truthful reading of a defect, not a new defect, but the sweep is also the natural place to settle
the orphan. autnmy/oh-hai#975 (an ack that matched nothing counted as delivery evidence) matters
more here than before: an `acknowledged` receipt MUST be emitted only from an ack that consumed the
entry.

**Migration — clients.** Declare `receipt_events` at registration and check the echo; accept the two
events in the receipt handler with the per-event shape; keep a terminal-seen set so a late `unread`
is ignored; surface `unread` as "not yet picked up", never as "failed".

## Security considerations

**The trust boundary does not move.** Every receipt proposed here is a push of state its recipient
can already read on its own submitter-bound §8.2 pull: `mailbox.state`, `delivered_at`,
`acknowledged_at`. The measure for each item below is therefore whether *pushing* creates something
*pulling* did not.

- **Spoofing a receipt.** Unchanged mechanism, higher stakes. §9.8 already requires verification
  because *"an unverified receipt could fabricate a bounce and trick a sender into abandoning a live
  ask"*; a fabricated `acknowledged` would do the opposite harm — quiet a sender whose mail is
  stranded — and a fabricated `unread` could provoke duplicate sends. `event`, `prior`, `session`,
  `at`, `id` and `in_reply_to` are all inside `receipt_sha256`; `to` is bound and reconstructed from
  the verifier's own drain identity. No field is added outside the digest, which is why `note` is
  excluded (S3).
- **Replay.** Per-delivery `t`/`jti` and the `(in_reply_to, event)` dedup apply unchanged. One new
  case: a replayed or merely reordered `unread` arriving after the terminal receipt. The B2 consumer
  rule (ignore a non-terminal event once a terminal one is accepted) covers it.
- **Information leak about a peer's liveness.** The content of the new receipts adds nothing to
  §8.2. Their *timing* does add convenience: a sender learns of a peer's ack without asking. A sender
  could already long-poll (§8.2 `?wait=`) for the same latency, so this is not a new oracle, but it
  lowers the cost of building a liveness monitor from sends. Bounds: the leg is account-opt-in, the
  sender must already be permitted to address the destination (allowlists, §8.0), each probe is a
  real message the destination's operator can audit (§8.7.1), and the claimant session of
  principal-addressed mail is withheld from the new events (S3). `unread` reveals only non-ack within
  `U` — deliberately not *why*, so an operator stop, a crash, and a busy agent remain
  indistinguishable, preserving §16.4's attribution boundary.
- **Amplification and loops.** Per addressed message the Hub emits at most two receipts (`unread`,
  then one terminal), only to the submitting session, only into a mailbox the sender itself must
  drain. Receipts never generate receipts and are not command entries, so they are never themselves
  `unread`-eligible and never count as unread mail for a #1177-style rule. There is no path by which
  a receipt causes a send, so §8.6's deferred hop-limit is not brought forward. A sender cannot
  redirect receipts to another session: that would let any agent make the Hub deliver signed,
  Hub-originated entries to a victim at the cost of one submit each.
- **Denial of attention.** A hostile or broken *destination* that never acks makes each of its
  senders receive one `unread` per message. That is the feature; the cap is one per message, and
  `"receipts": []` silences it per send.
- **The sender-side invitation to duplicate.** The most likely real-world harm is a well-meaning
  sender that re-sends on `unread`, so a command runs twice when the reader returns. Hence the SHOULD
  NOT in B2 and the client-migration wording.
- **Custody as a claim.** Pinning the ack as custody removes an implied claim ("acted") the protocol
  could never check. It adds a MUST NOT (acking what one cannot present) that a Hub also cannot
  check; it is auditable only from the client side, and the SCP does not pretend otherwise.

## Conformance

Vectors that would be needed — listed, not written.

**Schema-validation (`v0.7/`):** receipt `unread` valid with `prior: "queued"` and with `prior:
"delivered"`; `unread` without `prior` invalid; `acknowledged` valid without `prior`; `acknowledged`
**with** `prior` invalid; both new events valid with and without `session`; `bounced` without
`session` still invalid; a post-0.6 event at a declared minor < 7 invalid; **the same `unread`
receipt invalid against `v0.6/inbound-message.schema.json`** (pins the fact S1 exists to respect);
`registerRequest.receipt_events` with `unread` but not `acknowledged` invalid; an unknown event name
invalid; capability listing `unread` without `unread_after_seconds` invalid; either capability member
at a declared minor < 7 invalid; envelope `receipts` valid/unknown-member invalid; submit-ack
`receipts` valid.

**Signature:** `receipt_sha256` reproduces for an `acknowledged` receipt whose `prior` and `session`
serialize as `null` (the first vectors to exercise §9.8's `null` convention on this digest); a
flipped `event` (`unread` → `acknowledged`) fails verification.

**Downstream proofs (a new `dp-0xx`, plus edits to `dp-022` obligation (6) and `dp-020` (9)):**
(1) a session that declared nothing never receives a post-0.6 event, under every other setting;
(2) `unread` is emitted at most once per entry under N concurrent sweeps; (3) no `unread` after a
terminal track state, and none for a message whose §7 resolution is already terminal; (4) the
correction: `unread` then ack ⇒ an `acknowledged` receipt even with no per-message request;
(5) `unread` then session death ⇒ `bounced` with the truthful `prior`, and no `acknowledged`; (6) an
`acknowledged` receipt is emitted only from the ack that won the track's CAS — a repeat ack, a
no-match ack, and a session-less ack that consumed nothing emit none; (7) no receipt of any kind to a
sender that named no session, or whose session is terminal; (8) the new events never carry a
principal-addressed claimant's session id; (9) receipts never generate receipts and are never
`unread`-eligible; (10) `receipts` is stripped from the delivered `message` entry and the entry's
signature verifies without it; (11) the `202` echo equals `requested ∩ declared ∩ offered`, and is
absent on a Hub not offering the feature; (12) a conformant client ignores an `unread` that arrives
after a terminal receipt for the same `in_reply_to`; (13) a Hub declining to extend a lease on a
non-consuming touchpoint still returns the touchpoint's normal response.

**Prose audit (`pa-0xx`):** no spec sentence describes `acknowledged` as read, seen, or acted on.

## Reference implementation

None yet; a design document without code cannot reach Accepted, and none is claimed. On a ruling, the
linked PR grows `reference/src/hub.ts` (the declared set on `SessionRecord`; the `unread` stamp and
sweep beside `sweepRetention`; emission from the ack transition next to
`emitBounceReceipt`, which generalizes to one `emitReceipt`), `reference/src/signing.ts` (no change
to `computeReceiptSha256` — it already nulls absent members), and the conformant-client layer
(`receiveReceipt` per-event shape, the terminal-seen rule, the registration echo check). The first
production implementation would be the Hub that produced the measurement, where the #1177 sweep
predicate and the #1181 stamp already sit in the single renewing UPDATE the new stamp would join.

## Unresolved questions

1. **Does the custody definition belong in this SCP or in a direct PR?** It changes no wire behavior
   (CONTRIBUTING's clarification path), but it adds a MUST NOT and A is unsafe without it.
2. **Is `U` Hub-wide, or may a sender shorten it per message** (a `receipts` object form with an
   `unread_after_seconds`, clamped to an advertised floor)? Per-message bounds fit senders that know
   a reply is urgent; they also turn one sweep predicate into a per-entry deadline.
3. **Should `unread` repeat** (say, once more at 4·`U`)? This draft says once: a repeating advisory
   is a heartbeat the sender did not ask for, and the pull is there.
4. **A receipt for delivery-track `expired`**, which would give principal-addressed mail a pushed
   terminal. It requires rewording `dp-022` obligation (5).
5. **Should directives get the same advisory toward the human?** The human has no session; the
   surface would be the §14.4 track plus product push (autnmy/oh-hai#655). This draft keeps receipts
   agent-sender-only and treats the human side as product.
6. **MAY or SHOULD** for a Hub offering `inter_agent` to offer `unread`.
7. **Is clarification (ii) acceptable as a clarification**, or is removing *"a submit naming the
   session"* from addressed-message reachability a change that wants its own SCP?
8. **System senders** (a webhook source feeding an agent's mailbox through a Hub's own ingest
   surface) hold no session and gain nothing from A or B. Is that a gap for the protocol, or
   correctly a product surface of the Hub that offers ingest?

## Future possibilities

- **An agent-level `seen` marker** (the XEP-0333 shape), if and when agent runtimes expose a
  trustworthy presentation hook and a second implementation wants it. It would need a new §9.8
  receipt shape or a digest revision, which is the reason to be sure first.
- **An OPTIONAL standardized `last_acted`** on the session resource, as a §15.1 derivation, once more
  than one Hub derives it.
- **Webhook delivery of receipts**, riding the roadmap item for the v0.5 entry kinds (§10), which
  would reach session-less senders that hold a verified callback.
- **Name-scoped receipts** under SCP #69, where the `session` member of a receipt for name-addressed
  mail would need the same "nothing the sender did not write" rule this draft applies.
