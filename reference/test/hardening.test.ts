// Regression tests locking in the review-round fixes (codex + adversarial + correctness passes):
// authz bypasses via the `#` grammar and the human/agent namespace, the inter-agent account
// opt-in gate, expiry-vs-undeliverable precedence, session-addressed directive consumption, the
// response-ack cross-principal leak, the resolve-return state strip, own-session visibility, and
// the addressed-submit expires_at check. Each asserts the SECURE outcome, so a regression re-opens
// the exact hole a reviewer found.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hub, HubError } from "../src/hub.js";
import { Agent } from "../src/agent.js";
import type { AskMessage } from "../src/types.js";

const KEY = "hub-hardening-key-0123456789abcdef0123456789abcd";
const T0 = 1_786_752_000_000;
const SENDER = "overseer/fleet";
const WORKER = "deploybot/dev-team";
const OWNER = "human:you";

function newHub(now: { t: number }, opts?: { sessionVisibility?: boolean; enableLeg?: boolean }): Hub {
  const hub = new Hub({
    signingKey: KEY,
    now: () => now.t,
    sessionMinTtlSeconds: 60,
    ...(opts?.sessionVisibility !== undefined ? { sessionVisibility: opts.sessionVisibility } : {}),
  });
  hub.setAgentOwner(SENDER, OWNER);
  hub.setAgentOwner(WORKER, OWNER);
  if (opts?.enableLeg !== false) hub.setInterAgentEnabled(OWNER);
  return hub;
}

function ask(over: { to?: string; session?: string } & Partial<AskMessage> = {}): AskMessage {
  const { to, session, ...rest } = over;
  return {
    ma2h_version: "0.5",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_01", runtime: "cli", ...(session !== undefined ? { session } : {}) },
    ...(to !== undefined ? { to: to as AskMessage["to"] } : {}),
    title: "May I restart your queue consumer?",
    idempotency_key: "k",
    request: { mode: "confirm" },
    ...rest,
  } as AskMessage;
}

// ---- adversarial adv-1: the `#sess_` resolver-authz bypass ----

test("resolveAsAgent rejects a `#`-bearing principal — closing the truncation authz bypass (§4/§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.registerSession(WORKER);
  const { id } = hub.submit(ask({ to: `agent:${WORKER}` })); // addressee default = WORKER, any session

  // Attacker holds a credential for a cross-account agent whose id literally contains the `#sess_`
  // separator. Before the fix, `agent:${principal}` naive-concatted and assertAuthorized truncated
  // it back to `deploybot/dev-team` via parseAddress — forging the addressee's decision.
  assert.throws(
    () => hub.resolveAsAgent(id, `${WORKER}#sess_evil`, { resolution: "answered", value: "approve" }),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );

  // Variant: a session-qualified restriction pinned to one invocation must not be satisfiable by a
  // principal whose id is byte-identical to the qualified entry.
  const restricted = ask({ to: `agent:${WORKER}` });
  const sA = hub.registerSession(WORKER).session;
  restricted.request.allowed_resolvers = [`agent:${WORKER}#${sA.id}`];
  const { id: id2 } = hub.submit(restricted);
  assert.throws(
    () => hub.resolveAsAgent(id2, `${WORKER}#${sA.id}`, { resolution: "answered", value: "approve" }),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );
  // The legitimate addressee under its real session still resolves.
  assert.equal(
    hub.resolveAsAgent(id2, WORKER, { resolution: "answered", value: "approve" }, { session: sA.id }).status,
    "answered",
  );
});

// ---- adversarial adv-2: the human/agent namespace collision ----

test("an agent provisioned with the account human's owner id cannot hijack the session kill-switch / read (§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(WORKER);
  // The attacker provisions an agent whose id string equals the account human's owner id and
  // authenticates as that bare principal. The account-human branch must NOT treat it as the human.
  hub.setAgentOwner(OWNER, "human:attacker-account");
  assert.throws(
    () => hub.getSession(session.id, OWNER),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
    "no read hijack",
  );
  assert.throws(
    () => hub.closeSession(session.id, OWNER),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
    "no kill hijack",
  );
  assert.equal(hub.getSession(session.id, WORKER).session.state, "active", "the victim session is untouched");
});

// ---- codex: the inter-agent account opt-in gate ----

test("addressed submits are rejected until the account opts into the inter-agent leg (§8.0)", () => {
  const now = { t: T0 };
  const hub = newHub(now, { enableLeg: false });
  hub.registerSession(WORKER);
  assert.throws(
    () => hub.submit(ask({ to: `agent:${WORKER}` })),
    (e: unknown) => e instanceof HubError && e.code === "not_authorized",
    "the leg defaults off",
  );
  // A human-inbox submit from the same account is unaffected (the gate is leg-specific).
  assert.equal(hub.submit(ask()).status, "open");
  // Opting in turns it on.
  hub.setInterAgentEnabled(OWNER);
  assert.equal(hub.submit(ask({ to: `agent:${WORKER}` })).status, "open");
});

// ---- correctness #1: expiry beats undeliverable ----

test("a bounce after the message-level expires_at resolves `expired` with the default, not system:undeliverable (§7)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const expiring = ask({ to: `agent:${WORKER}#${workerSession.id}` });
  expiring.expires_at = new Date(T0 + 10_000).toISOString();
  expiring.request.default_on_expire = "deny";
  const { id } = hub.submit(expiring);

  now.t = T0 + 60_000; // the session dies AFTER expiry already fired (Hub clock, §9.5)
  hub.closeSession(workerSession.id, WORKER);
  const got = hub.get(id, SENDER);
  assert.equal(got?.status, "expired", "expiry won the CAS, not the bounce");
  assert.equal(got?.response?.defaulted, true);
  assert.equal(got?.response?.response?.actor, "system:default_on_expire");
  assert.equal(got?.response?.response?.value, "deny", "default_on_expire applied — not lost");
});

// ---- correctness #2: session-addressed directive consumption ----

test("a session-addressed directive is consumed by its own current session and refused for a prior one (§13.2/§13.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  hub.sendDirective({ from: OWNER, to: `agent:${WORKER}#${workerSession.id}`, title: "for that session" });
  const entries = hub.drainInbox(WORKER, { session: workerSession.id });
  assert.equal(entries.length, 1);
  const entry = entries[0];
  if (!entry || !("directive" in entry)) return assert.fail("expected a directive entry");

  const current = new Agent({
    callbackUrl: "https://worker.example/r",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${WORKER}`,
    session: workerSession.id,
  });
  assert.equal(current.receiveDirective(entry.directive, entry.signature, now.t).acted, true, "own session accepts");

  const stale = new Agent({
    callbackUrl: "https://worker.example/r",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${WORKER}`,
    session: "sess_a-different-run",
  });
  const res = stale.receiveDirective(entry.directive, entry.signature, now.t);
  assert.equal(res.acted, false);
  assert.match(res.acted === false ? res.reason : "", /session mismatch/);
});

// ---- correctness #3: the response-ack cross-principal leak ----

test("a foreign principal presenting a resolution_id it does not own gets nothing back (§8.7/§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(SENDER).session;
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}`, session: senderSession.id }));
  hub.drainInbox(WORKER, { session: workerSession.id });
  const resolved = hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: workerSession.id });
  // The submitter drains + acks its own response entry (with a private note).
  hub.drainInbox(SENDER, { session: senderSession.id });
  hub.ackInbox(SENDER, [resolved.resolution_id], { session: senderSession.id, note: "resuming the deploy" });

  // WORKER (a different principal that happens to hold the resolution_id) must NOT read the
  // submitter's ack via the idempotent-retry path.
  const leak = hub.ackInbox(WORKER, [resolved.resolution_id], { session: workerSession.id });
  assert.equal(leak.acked, 0);
  assert.equal(leak.acks.length, 0, "no cross-principal ack leak");
});

// ---- correctness #4: the resolve-return state strip ----

test("resolveAsAgent does not hand the resolving addressee the submitter's opaque state (§8.8/§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const withState = ask({ to: `agent:${WORKER}` });
  withState.state = { sealed: "v1.submitter-secret" };
  const { id } = hub.submit(withState);
  const out = hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: workerSession.id });
  assert.equal(out.response.state, undefined, "the addressee never sees the submitter's resume blob");
  // The submitter's OWN submitter-bound GET still round-trips its state (§6).
  assert.deepEqual(hub.get(id, SENDER)?.response?.state, { sealed: "v1.submitter-secret" });
});

// ---- correctness #5: own-session visibility is unconditional ----

test("under visibility-off, a sender addressing its OWN terminal session still gets the honest 410 split (§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now, { sessionVisibility: false });
  const ownDead = hub.registerSession(SENDER).session;
  hub.closeSession(ownDead.id, SENDER);
  // Own principal → honest destination_gone (own-session visibility is unconditional).
  const self = ask({ to: `agent:${SENDER}#${ownDead.id}` });
  self.agent.id = SENDER;
  assert.throws(
    () => hub.submit(self),
    (e: unknown) => e instanceof HubError && e.code === "destination_gone",
  );
  // A third-party sender → collapsed to unknown_destination (the oracle guard still holds).
  const workerDead = hub.registerSession(WORKER).session;
  hub.closeSession(workerDead.id, WORKER);
  assert.throws(
    () => hub.submit(ask({ to: `agent:${WORKER}#${workerDead.id}` })),
    (e: unknown) => e instanceof HubError && e.code === "unknown_destination",
  );
});

// ---- correctness #7: the addressed-submit expires_at check ----

test("an addressed submit with a past expires_at is rejected, not accepted as a corpse (§4/§8.5)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.registerSession(WORKER);
  const past = ask({ to: `agent:${WORKER}` });
  past.expires_at = new Date(T0 - 1_000).toISOString();
  assert.throws(
    () => hub.submit(past),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );
});
