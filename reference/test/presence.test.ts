// Presence / "listening" (spec §15, v0.4) — derived from existing poll/subscription activity;
// online/offline/unknown by the freshness window; owner-only read (§15.3).

import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../src/hub.js";

const KEY = "hub-presence-key-0123456789abcdef0123456789abcdef";
const T0 = 1_782_056_000_000;
const AGENT = "deploybot/dev-team";
const OWNER = "human:you";

function newHub(now: { t: number }): Hub {
  const hub = new Hub({ signingKey: KEY, now: () => now.t, presenceFreshnessSeconds: 90 });
  hub.setAgentOwner(AGENT, OWNER); // provision: this agent belongs to OWNER
  return hub;
}

test("unknown before any activity — never-seen is distinct from offline (§15.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const p = hub.getPresence(AGENT, OWNER);
  assert.equal(p.state, "unknown");
  assert.equal(p.last_seen, undefined);
  assert.equal(p.freshness_seconds, 90);
});

test("online after a poll within the freshness window (derived, §15.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.drainInbox(AGENT); // a mailbox drain is presence activity
  const p = hub.getPresence(AGENT, OWNER);
  assert.equal(p.state, "online");
  assert.equal(p.last_seen, new Date(T0).toISOString());
});

test("a message GET also refreshes presence (§15.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.get("msg_does_not_exist", AGENT); // an authenticated poll counts even for an unknown id
  assert.equal(hub.getPresence(AGENT, OWNER).state, "online");
});

test("offline once last_seen falls outside the window (§15.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.drainInbox(AGENT);
  assert.equal(hub.getPresence(AGENT, OWNER).state, "online");
  now.t += 91_000; // past the 90s window
  const p = hub.getPresence(AGENT, OWNER);
  assert.equal(p.state, "offline");
  assert.equal(p.last_seen, new Date(T0).toISOString(), "last_seen is retained; only the state ages out");
});

test("owner-only: a non-owner reads `unknown` with no last_seen, even for an online agent (§15.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.drainInbox(AGENT); // AGENT is online
  assert.equal(hub.getPresence(AGENT, OWNER).state, "online", "the owner sees online");
  const other = hub.getPresence(AGENT, "human:someone-else");
  assert.equal(other.state, "unknown", "a non-owner sees unknown");
  assert.equal(other.last_seen, undefined, "and never learns the activity timing");
});

test("presence is per-agent — one agent's activity does not make another online", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.setAgentOwner("other/agent", OWNER); // owned by the same human, but never active
  hub.drainInbox(AGENT);
  assert.equal(hub.getPresence(AGENT, OWNER).state, "online");
  assert.equal(hub.getPresence("other/agent", OWNER).state, "unknown");
});
