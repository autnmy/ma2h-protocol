// Sessions (spec §16, v0.5) — registration, lease renewal from client-originated activity, the
// first-terminal-wins CAS on close/expire, the account-human kill-switch, own-session visibility,
// terminal retention + purge, and the §8.7.2 stream hold bound.

import test from "node:test";
import assert from "node:assert/strict";
import { Hub, HubError } from "../src/hub.js";

const KEY = "hub-session-key-0123456789abcdef0123456789abcdef";
const T0 = 1_786_752_000_000; // fixed base; ms
const AGENT = "deploybot/dev-team";
const OTHER = "overseer/fleet";
const OWNER = "human:you";

function newHub(now: { t: number }, opts?: { maxLive?: number; terminalRetentionSeconds?: number }): Hub {
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
  });
  hub.setAgentOwner(AGENT, OWNER);
  hub.setAgentOwner(OTHER, OWNER);
  hub.setInterAgentEnabled(OWNER); // §8.0: the addressed-submit reachability test needs the leg on
  return hub;
}

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
