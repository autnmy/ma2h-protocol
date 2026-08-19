// Sessions (spec §16, v0.5) — registration, lease renewal from client-originated activity, the
// first-terminal-wins CAS on close/expire, the account-human kill-switch, own-session visibility,
// terminal retention + purge, the §8.7.2 stream hold bound, the §16.3/§16.4 operator-close marker
// (the 410 split: `gone` vs `session_closed_by_operator`), and the §14.2 explicit mailbox `prior`.

import test from "node:test";
import assert from "node:assert/strict";
import { Hub, HubError } from "../src/hub.js";
import { validateV05Def } from "../src/envelope.js";
import type { AskMessage, InboxEntryDelivery } from "../src/types.js";

const KEY = "hub-session-key-0123456789abcdef0123456789abcdef";
const T0 = 1_786_752_000_000; // fixed base; ms
const AGENT = "deploybot/dev-team";
const OTHER = "overseer/fleet";
const OWNER = "human:you";

function newHub(
  now: { t: number },
  opts?: { maxLive?: number; terminalRetentionSeconds?: number; sessionVisibility?: boolean },
): Hub {
  const hub = new Hub({
    signingKey: KEY,
    now: () => now.t,
    sessionMinTtlSeconds: 60,
    sessionMaxTtlSeconds: 3600,
    sessionDefaultTtlSeconds: 900,
    ...(opts?.maxLive !== undefined ? { sessionMaxLivePerAgent: opts.maxLive } : {}),
    ...(opts?.terminalRetentionSeconds !== undefined
      ? { sessionTerminalRetentionSeconds: opts.terminalRetentionSeconds }
      : {}),
    ...(opts?.sessionVisibility !== undefined ? { sessionVisibility: opts.sessionVisibility } : {}),
  });
  hub.setAgentOwner(AGENT, OWNER);
  hub.setAgentOwner(OTHER, OWNER);
  hub.setInterAgentEnabled(OWNER); // §8.0: the addressed-submit reachability test needs the leg on
  return hub;
}

/** A v0.5 ask fixture for the marker/`prior` touchpoint tests (submitter OTHER unless overridden). */
function ask(over: { to?: string; session?: string; from?: string; expires_at?: string; key?: string } = {}): AskMessage {
  return {
    ma2h_version: "0.5",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: {
      id: over.from ?? OTHER,
      run_id: "run_1",
      runtime: "cli",
      ...(over.session !== undefined ? { session: over.session } : {}),
    },
    ...(over.to !== undefined ? { to: over.to as AskMessage["to"] } : {}),
    title: "May I proceed?",
    idempotency_key: over.key ?? "ask-1",
    request: { mode: "confirm" },
    ...(over.expires_at !== undefined ? { expires_at: over.expires_at } : {}),
  } as AskMessage;
}

const isMarker = (e: unknown): boolean => e instanceof HubError && e.code === "session_closed_by_operator";
const isGone = (e: unknown): boolean => e instanceof HubError && e.code === "gone";
const isDestinationGone = (e: unknown): boolean => e instanceof HubError && e.code === "destination_gone";

test("register mints a sess_ id, state active, and clamps the requested ttl into the advertised bounds (§16.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(AGENT, { label: "dev-team · issue #26", kind: "worker" });
  assert.match(session.id, /^sess_/);
  assert.equal(session.state, "active");
  assert.equal(session.agent_id, AGENT);
  assert.equal(session.ttl_seconds, 900, "default ttl applies when none requested");
  assert.equal(session.label, "dev-team · issue #26");
  // Lower clamp (§16.1): keeps every lease comfortably above the stream hold bound.
  assert.equal(hub.registerSession(AGENT, { ttl_seconds: 5 }).session.ttl_seconds, 60);
  // Upper clamp.
  assert.equal(hub.registerSession(AGENT, { ttl_seconds: 999_999 }).session.ttl_seconds, 3600);
});

test("an agent.id containing `#` cannot register sessions (§4 grammar / §16.1)", () => {
  const hub = newHub({ t: T0 });
  assert.throws(
    () => hub.registerSession("we#ird"),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );
});

test("the live-session cap rejects over-cap registration with 429 rate_limited (§16.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now, { maxLive: 2 });
  hub.registerSession(AGENT);
  const second = hub.registerSession(AGENT).session;
  assert.throws(
    () => hub.registerSession(AGENT),
    (e: unknown) => e instanceof HubError && e.code === "rate_limited",
  );
  // Closing one frees the cap.
  hub.closeSession(second.id, AGENT);
  assert.equal(hub.registerSession(AGENT).session.state, "active");
});

test("another principal's session is indistinguishable from unknown, and never listed (§16.4/§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(AGENT);
  assert.throws(
    () => hub.getSession(session.id, OTHER),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
  );
  assert.throws(
    () => hub.closeSession(session.id, OTHER),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
  );
  assert.equal(hub.listSessions(OTHER).sessions.length, 0);
  // Own-session visibility is unconditional (§16.4).
  assert.equal(hub.listSessions(AGENT).sessions[0]?.id, session.id);
});

test("the list body reports the APPLIED §16.4 scope, independent of the advertised ceiling (SCP #62)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(AGENT, {});

  const listed = hub.listSessions(AGENT);
  assert.equal(listed.sessions[0]?.id, session.id);
  // This Hub implements no account-wide grant, so `own` is the only honest answer — and it is a
  // COMPLETE one, not a degraded reading: own-session visibility is unconditional (§16.4).
  assert.equal(listed.scope, "own");

  // The scope is NOT the ceiling. `sessionVisibility` models `sessions.agent_list_visibility`,
  // which SCP #62 makes a DEPLOYMENT CEILING — it bounds what an account MAY be granted and says
  // nothing about what this caller got. Deriving `scope` from it is precisely the conflation the
  // field exists to end, so flipping the ceiling must not move the per-caller answer.
  for (const ceiling of [true, false]) {
    const other = newHub({ t: T0 }, { sessionVisibility: ceiling });
    other.registerSession(AGENT, {});
    assert.equal(other.listSessions(AGENT).scope, "own", `ceiling ${ceiling} must not change the applied scope`);
  }

  // And the emitted body is the wrapper §16.1 names for it — the `scope` the Hub adds has to
  // validate, not merely be tolerated by a validator that never saw the collection shape.
  assert.equal(validateV05Def("session.schema.json", "sessionList", listed).valid, true);
  // Fail-closed check on the assertion above: a bogus scope must NOT validate, or the line above
  // would pass against a schema that had stopped constraining the field at all.
  assert.equal(
    validateV05Def("session.schema.json", "sessionList", { ...listed, scope: "everything" }).valid,
    false,
  );
});

test("a ?session= drain renews the lease and stamps last_seen; a session-less ack renews nothing (§16.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(AGENT, { ttl_seconds: 900 });
  const expiry0 = Date.parse(hub.getSession(session.id, AGENT).session.expires_at);

  now.t = T0 + 600_000; // inside the lease
  hub.drainInbox(AGENT, { session: session.id });
  const renewed = hub.getSession(session.id, AGENT).session;
  assert.equal(Date.parse(renewed.expires_at), now.t + 900_000, "drain renewed the lease from now");
  assert.ok(Date.parse(renewed.expires_at) > expiry0);
  assert.equal(renewed.last_seen, new Date(now.t).toISOString());

  // A session-LESS ack is not attributable to any session and renews no lease (§8.7).
  now.t = T0 + 700_000;
  hub.ackInbox(AGENT, ["dir_nothing"]);
  assert.equal(
    Date.parse(hub.getSession(session.id, AGENT).session.expires_at),
    T0 + 600_000 + 900_000,
    "unchanged by the session-less ack",
  );
});

test("lease lapse is a terminal, immutable expiry — a later close cannot rewrite it (§16.3 CAS)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(AGENT, { ttl_seconds: 60 });
  now.t = T0 + 61_000; // past the lease
  const read = hub.getSession(session.id, AGENT).session;
  assert.equal(read.state, "expired");
  assert.equal(read.closed_at, new Date(T0 + 60_000).toISOString(), "terminal at lease end, not read time");
  // First-terminal-wins: close after expiry is a no-op returning the existing terminal.
  const closed = hub.closeSession(session.id, AGENT).session;
  assert.equal(closed.state, "expired");
  assert.equal(closed.closed_at, new Date(T0 + 60_000).toISOString());
});

test("close is owner-only + idempotent; the account human holds the kill-switch (§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const a = hub.registerSession(AGENT).session;
  const closed = hub.closeSession(a.id, AGENT).session;
  assert.equal(closed.state, "closed");
  assert.equal(closed.closed_at, new Date(T0).toISOString());
  assert.equal(hub.closeSession(a.id, AGENT).session.state, "closed", "re-close is idempotent");

  // The account's authenticated human may close any account session (the kill-switch).
  const b = hub.registerSession(AGENT).session;
  assert.equal(hub.closeSession(b.id, OWNER).session.state, "closed");

  // A non-owner human is indistinguishable from unknown.
  const c = hub.registerSession(AGENT).session;
  assert.throws(
    () => hub.closeSession(c.id, "human:someone-else"),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
  );
});

test("terminal sessions stay readable for the retention window, then purge (§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now, { terminalRetentionSeconds: 100 });
  const { session } = hub.registerSession(AGENT);
  hub.closeSession(session.id, AGENT);
  now.t = T0 + 90_000; // inside terminal retention
  assert.equal(hub.getSession(session.id, AGENT).session.state, "closed");
  now.t = T0 + 101_000; // past it
  assert.throws(
    () => hub.getSession(session.id, AGENT),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
  );
  assert.equal(hub.listSessions(AGENT).sessions.length, 0);
});

test("the stream hold bound is <= the advertised hold and strictly clear of lease expiry (§8.7.2)", () => {
  const now = { t: T0 };
  const hub = new Hub({
    signingKey: KEY,
    now: () => now.t,
    sessionMinTtlSeconds: 60,
    streamMaxHoldSeconds: 30,
  });
  hub.setAgentOwner(AGENT, OWNER);
  const { session } = hub.registerSession(AGENT, { ttl_seconds: 900 });
  const bound = hub.streamHoldBoundMs(session.id, AGENT);
  assert.equal(bound, 30_000, "far from expiry, the advertised hold governs");

  // Near lease expiry the bound shrinks BELOW the remaining lease by a NONZERO margin — closing
  // exactly AT expiry would hand the client a renewal moment it can only use after the lease is
  // already immutably terminal (§8.7.2).
  now.t = T0 + 890_000; // 10s of lease left
  const nearBound = hub.streamHoldBoundMs(session.id, AGENT);
  const remaining = 10_000;
  assert.ok(nearBound < remaining, "bounded before expiry");
  assert.ok(nearBound > 0, "still a usable hold");
  assert.ok(remaining - nearBound >= 1, "nonzero margin");
});

test("registration itself is session-bearing activity: the reachability snapshot can read online (§15.1/§16.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.registerSession(AGENT);
  const ack = hub.submit({
    ma2h_version: "0.5",
    type: "notify",
    created_at: new Date(now.t).toISOString(),
    agent: { id: OTHER, run_id: "run_1", runtime: "cli" },
    to: `agent:${AGENT}`,
    title: "fyi",
  });
  assert.equal(ack.destination?.state, "online");
});

// ---- The §16.3/§16.4 operator-close marker: the 410 split by WHO terminated the session ----

test("every own-session touchpoint on an operator-closed session reads session_closed_by_operator — stop, not re-register (§16.3/§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const dead = hub.registerSession(AGENT).session;
  const { id } = hub.submit(ask({ to: `agent:${AGENT}` })); // an addressed ask AGENT could resolve
  hub.closeSession(dead.id, OWNER); // the §16.4 kill-switch

  // Presentation touchpoints (§16.3 table): drain, ack (?session=), resolve (?session=), stream connect.
  assert.throws(() => hub.drainInbox(AGENT, { session: dead.id }), isMarker);
  assert.throws(() => hub.ackInbox(AGENT, [id], { session: dead.id }), isMarker);
  assert.throws(
    () => hub.resolveAsAgent(id, AGENT, { resolution: "answered", value: "approve" }, { session: dead.id }),
    isMarker,
  );
  assert.throws(() => hub.streamHoldBoundMs(dead.id, AGENT), isMarker);
  // A submit naming the submitter's OWN killed agent.session (§4.1) — the caller is the killed party.
  assert.throws(() => hub.submit(ask({ from: AGENT, session: dead.id, key: "ask-2" })), isMarker);
});

test("expired and self-closed sessions keep the plain 410 gone on presentation and stream connect — re-register and continue (§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const selfClosed = hub.registerSession(AGENT).session;
  hub.closeSession(selfClosed.id, AGENT); // the OWNING principal's own DELETE — no marker
  assert.throws(() => hub.drainInbox(AGENT, { session: selfClosed.id }), isGone);
  assert.throws(() => hub.streamHoldBoundMs(selfClosed.id, AGENT), isGone);

  const lapsed = hub.registerSession(AGENT, { ttl_seconds: 60 }).session;
  now.t = T0 + 61_000; // the lease lapses
  assert.throws(() => hub.drainInbox(AGENT, { session: lapsed.id }), isGone);
  assert.throws(() => hub.streamHoldBoundMs(lapsed.id, AGENT), isGone);
});

test("a submit naming an expired or self-closed own agent.session keeps 410 destination_gone — the unchanged §4.1 wire contract (§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const selfClosed = hub.registerSession(AGENT).session;
  hub.closeSession(selfClosed.id, AGENT);
  assert.throws(() => hub.submit(ask({ from: AGENT, session: selfClosed.id })), isDestinationGone);

  const lapsed = hub.registerSession(AGENT, { ttl_seconds: 60 }).session;
  now.t = T0 + 61_000;
  assert.throws(() => hub.submit(ask({ from: AGENT, session: lapsed.id, key: "ask-2" })), isDestinationGone);
});

test("an addressed `to` naming an operator-closed session stays destination_gone regardless of ownership — no §16.5 oracle (§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const dead = hub.registerSession(AGENT).session;
  hub.closeSession(dead.id, OWNER); // the operator kill
  // A same-account third-party sender never learns WHO terminated the destination.
  assert.throws(() => hub.submit(ask({ to: `agent:${AGENT}#${dead.id}` })), isDestinationGone);
  // Nor does the submitter addressing its OWN other (killed) session — the marker rides only the
  // caller's own transport context, never the `to` routing path.
  const live = hub.registerSession(AGENT).session;
  assert.throws(
    () => hub.submit(ask({ from: AGENT, session: live.id, to: `agent:${AGENT}#${dead.id}`, key: "ask-2" })),
    isDestinationGone,
  );
});

test("the marker rides the terminal CAS: never retroactive on an expired lease, never dropped from a closed session (§16.3/§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  // An operator close AFTER the lease lapsed is an idempotent re-close of an expired terminal:
  // first-terminal-wins, so the session stays plain `expired` and no marker ever appears.
  const lapsed = hub.registerSession(AGENT, { ttl_seconds: 60 }).session;
  now.t = T0 + 61_000;
  const expired = hub.closeSession(lapsed.id, OWNER).session;
  assert.equal(expired.state, "expired");
  assert.ok(!("closed_by_operator" in expired), "a lapsed lease that won the CAS is never retroactively marked");
  // An operator close BEFORE expiry sets the marker; the original expires_at passing later never
  // flips the closed session to expired, so the marker never appears and then vanishes.
  const killed = hub.registerSession(AGENT, { ttl_seconds: 60 }).session;
  hub.closeSession(killed.id, OWNER);
  now.t += 120_000; // well past what would have been the lease expiry
  const read = hub.getSession(killed.id, AGENT).session;
  assert.equal(read.state, "closed");
  assert.equal(read.closed_by_operator, true);
});

test("getSession/listSessions surface closed_by_operator: true on an operator close and NO field on a self-close — true-only (§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const killed = hub.registerSession(AGENT).session;
  const selfClosed = hub.registerSession(AGENT).session;
  assert.equal(hub.closeSession(killed.id, OWNER).session.closed_by_operator, true, "the close response carries the marker");
  hub.closeSession(selfClosed.id, AGENT);

  assert.equal(hub.getSession(killed.id, AGENT).session.closed_by_operator, true);
  const self = hub.getSession(selfClosed.id, AGENT).session;
  assert.equal(self.state, "closed");
  assert.ok(!("closed_by_operator" in self), "true-only emission: absent on a self-close, never false");

  const listed = hub.listSessions(AGENT).sessions;
  assert.equal(listed.find((s) => s.id === killed.id)?.closed_by_operator, true);
  assert.ok(!("closed_by_operator" in (listed.find((s) => s.id === selfClosed.id) ?? {})));
});

test("a FOREIGN principal presenting the victim's operator-closed session id reads not_found, never the marker (§9.1/§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const dead = hub.registerSession(AGENT).session;
  hub.closeSession(dead.id, OWNER); // the §16.4 kill-switch
  // The ownership check precedes the marker branch (presentSession): to any principal that does not
  // own the session, an operator-closed id stays indistinguishable from unknown — the marker must
  // not become an oracle telling a third party WHO terminated someone else's session.
  const isNotFound = (e: unknown): boolean => e instanceof HubError && e.code === "not_found";
  assert.throws(() => hub.drainInbox(OTHER, { session: dead.id }), isNotFound);
  assert.throws(() => hub.ackInbox(OTHER, ["dir_anything"], { session: dead.id }), isNotFound);
});

test("streamClaim against an operator-closed session reads session_closed_by_operator — the presentSession funnel (§8.7.2/§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const dead = hub.registerSession(AGENT).session;
  hub.closeSession(dead.id, OWNER); // the §16.4 kill-switch
  assert.throws(() => hub.streamClaim(AGENT, dead.id), isMarker);
});

test("CAS boundary: with the clock exactly AT expires_at an operator close still wins — settle expiry is strictly > (§16.3/§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(AGENT, { ttl_seconds: 60 });
  now.t = T0 + 60_000; // t === expiresAtMs: the boundary instant, not yet PAST the lease
  assert.equal(Date.parse(session.expires_at), now.t, "the clock sits exactly on the lease boundary");
  const closed = hub.closeSession(session.id, OWNER).session;
  assert.equal(closed.state, "closed", "settleSessions' strict > leaves the boundary instant inside the lease");
  assert.equal(closed.closed_by_operator, true);
  assert.equal(closed.closed_at, new Date(T0 + 60_000).toISOString());
});

// ---- The §14.2 explicit mailbox `prior`: stamped once at the bounce transition ----

test("mailbox.prior: a never-drained bounce reads queued (no delivered_at), a drained orphan reads delivered — both equal the receipt's prior (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(OTHER).session;
  const target1 = hub.registerSession(AGENT).session;
  const target2 = hub.registerSession(AGENT).session;
  const neverDrained = hub.submit(ask({ to: `agent:${AGENT}#${target1.id}`, session: senderSession.id }));
  const orphaned = hub.submit(ask({ to: `agent:${AGENT}#${target2.id}`, session: senderSession.id, key: "ask-2" }));
  hub.drainInbox(AGENT, { session: target2.id }); // orphaned: drained, never acked (the §13.4 crash window)

  now.t = T0 + 10_000;
  hub.closeSession(target1.id, OWNER); // either terminal fires the §14.2 bounce —
  hub.closeSession(target2.id, AGENT); // the operator kill and a self-close alike

  const q = hub.get(neverDrained.id, OTHER);
  assert.equal(q?.mailbox?.state, "bounced");
  assert.equal(q?.mailbox?.prior, "queued");
  assert.equal(q?.mailbox?.delivered_at, undefined, "prior: queued asserts never-seen — no delivered_at beside it");
  const d = hub.get(orphaned.id, OTHER);
  assert.equal(d?.mailbox?.state, "bounced");
  assert.equal(d?.mailbox?.prior, "delivered");
  assert.equal(d?.mailbox?.delivered_at, new Date(T0).toISOString(), "the delivery timestamp is preserved");

  // One stamp, two surfaces (§14.2): each mailbox `prior` MUST equal its bounce receipt's `prior`.
  const entries = hub.drainInbox(OTHER, { session: senderSession.id });
  const receipts = entries.filter((e): e is Extract<InboxEntryDelivery, { receipt: unknown }> => "receipt" in e);
  assert.equal(receipts.find((e) => e.receipt.in_reply_to === neverDrained.id)?.receipt.prior, q?.mailbox?.prior);
  assert.equal(receipts.find((e) => e.receipt.in_reply_to === orphaned.id)?.receipt.prior, d?.mailbox?.prior);
});

test("an expired mailbox record carries NO prior — expired still means never delivered (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const target = hub.registerSession(AGENT).session;
  const { id } = hub.submit(
    ask({ to: `agent:${AGENT}#${target.id}`, expires_at: new Date(T0 + 10_000).toISOString() }),
  ); // queued, never drained
  now.t = T0 + 60_000; // the message-level expiry precedes the session death
  hub.closeSession(target.id, OWNER);
  const got = hub.get(id, OTHER);
  assert.equal(got?.mailbox?.state, "expired", "never delivered → expired, not a seen-then-lost bounce");
  assert.ok(!("prior" in (got?.mailbox ?? {})), "a prior here would smuggle back the never-delivered ambiguity");
});

test("directive delivery prior: a never-drained session-addressed directive bounced by the kill-switch reads prior queued, no delivered_at (§14.2/§13.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const target = hub.registerSession(AGENT).session;
  const { id } = hub.sendDirective({ from: OWNER, to: `agent:${AGENT}#${target.id}`, title: "hold deploys" });
  hub.closeSession(target.id, OWNER); // the account human's operator kill (not the owning principal)
  const d = hub.getDelivery(id, OWNER);
  assert.equal(d?.state, "bounced");
  assert.equal(d?.prior, "queued");
  assert.equal(d?.delivered_at, undefined, "prior: queued asserts never-seen — no delivered_at beside it");
});

test("directive delivery prior: a drained-but-unacked directive bounced by the kill-switch reads prior delivered (§14.2/§13.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const target = hub.registerSession(AGENT).session;
  const { id } = hub.sendDirective({ from: OWNER, to: `agent:${AGENT}#${target.id}`, title: "hold deploys" });
  assert.equal(hub.drainInbox(AGENT, { session: target.id }).length, 1); // delivered, never acked (the §13.4 crash window)
  now.t = T0 + 10_000;
  hub.closeSession(target.id, OWNER); // the operator kill orphans the seen directive
  const d = hub.getDelivery(id, OWNER);
  assert.equal(d?.state, "bounced");
  assert.equal(d?.prior, "delivered");
  assert.equal(d?.delivered_at, new Date(T0).toISOString(), "the delivery timestamp is preserved");
});
