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
import { Agent, BridgeExitError, EXIT_SIGNATURE_FAILURE, runBridgeLoop } from "../src/agent.js";
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

// ---- codex round 2 #1: expiry beats the bounce on the mailbox track too ----

test("a never-delivered session-addressed entry whose expiry precedes the session death bounces as `expired`, not `bounced` (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const expiring = ask({ to: `agent:${WORKER}#${workerSession.id}` });
  expiring.expires_at = new Date(T0 + 10_000).toISOString();
  expiring.request.default_on_expire = "deny";
  const { id } = hub.submit(expiring); // queued, never drained

  now.t = T0 + 60_000; // expiry (T+10s) precedes the death (T+60s), and nothing settled it between
  hub.closeSession(workerSession.id, WORKER);
  const got = hub.get(id, SENDER);
  assert.equal(got?.mailbox?.state, "expired", "never delivered → expired, not a seen-then-lost bounce");
  assert.equal(got?.status, "expired");
  assert.equal(got?.response?.response?.actor, "system:default_on_expire");
  // No bounce receipt for an expiry (§8.7.1: receipts carry only `bounced`).
  const senderSession = hub.registerSession(SENDER).session;
  void senderSession;
});

// ---- codex round 2 #2: shape-invalid entries are fatal in the bridge ----

test("a bridge exits EXIT_SIGNATURE_FAILURE on a shape-invalid mailbox entry (§8.7.1 verification)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.submit(ask({ to: `agent:${WORKER}` }));
  const tampering = {
    registerSession: (p: string, r?: Parameters<Hub["registerSession"]>[1], n?: number) => hub.registerSession(p, r, n),
    drainInbox: (p: string, o: { max?: number; now?: number; session: string }) => {
      const entries = hub.drainInbox(p, o);
      for (const e of entries) {
        if ("message" in e) {
          // Inject an unsigned forbidden field the §9.8 digest doesn't cover — shape validation
          // (not the signature) must catch it, and the bridge must treat that as fatal.
          (e.message as unknown as { state: unknown }).state = { sealed: "injected" };
        }
      }
      return entries;
    },
    ackInbox: (p: string, ids: string[], o?: { note?: string; now?: number; session?: string }) => hub.ackInbox(p, ids, o),
    closeSession: (s: string, c: string, n?: number) => hub.closeSession(s, c, n),
    resolveAsAgent: (id: string, p: string, b: Parameters<Hub["resolveAsAgent"]>[2], o?: Parameters<Hub["resolveAsAgent"]>[3]) =>
      hub.resolveAsAgent(id, p, b, o),
  };
  const agent = new Agent({
    callbackUrl: "https://worker.example/r",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${WORKER}`,
    senderPolicy: [SENDER],
  });
  try {
    runBridgeLoop(tampering, { principal: WORKER, agent, now: () => now.t });
    assert.fail("expected a loud exit");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_SIGNATURE_FAILURE);
  }
});

// ---- codex round 2 #3: v0.5 directives validate against the v0.5 schema ----

test("receiveDirective validates a >= 0.5 directive against the v0.5 schema (dir_ namespace normative)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  hub.sendDirective({ from: OWNER, to: `agent:${WORKER}#${workerSession.id}`, title: "hi" });
  const entries = hub.drainInbox(WORKER, { session: workerSession.id });
  const entry = entries[0];
  if (!entry || !("directive" in entry)) return assert.fail("expected a directive entry");
  const agent = new Agent({
    callbackUrl: "https://worker.example/r",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${WORKER}`,
    session: workerSession.id,
  });
  // A signed 0.5 directive whose id violates the normative `dir_` namespace must be refused by the
  // v0.5 shape check (the v0.4 schema would have accepted the opaque id).
  const badId = { ...entry.directive, id: "opaque-legacy-looking-id" };
  const res = agent.receiveDirective(badId, entry.signature, now.t);
  assert.equal(res.acted, false);
  assert.match(res.acted === false ? res.reason : "", /invalid directive/);
});

// ---- codex round 3 #1: settle sessions before a human resolution ----

test("a human resolve after the destination lease elapsed loses to the system:undeliverable bounce (§7/§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER, { ttl_seconds: 60 }).session;
  const withHuman = ask({ to: `agent:${WORKER}#${workerSession.id}` });
  withHuman.request.allowed_resolvers = [`agent:${WORKER}`, OWNER]; // the human is an explicit resolver
  const { id } = hub.submit(withHuman);

  now.t = T0 + 120_000; // the lease lapsed at T+60s; no session touchpoint has run since
  // The human tries to answer the (now-undeliverable) ask. The settle must bounce the dead session
  // FIRST, so the auto-cancellation wins the CAS and the human answer is the no-op.
  const out = hub.resolve(id, { actor: OWNER, resolution: "answered", value: "approve" });
  assert.equal(out.resolution, "cancelled");
  assert.equal(out.response?.actor, "system:undeliverable");
  assert.equal(hub.get(id, SENDER)?.status, "cancelled");
});

// ---- codex round 3 #2: response entries validate against the entry union (>= 0.5) ----

test("receiveResponseEntry refuses a pre-0.5 response body — entries require v0.5 (§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(SENDER).session;
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}`, session: senderSession.id }));
  hub.drainInbox(WORKER, { session: workerSession.id });
  const resolved = hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: workerSession.id });
  const entries = hub.drainInbox(SENDER, { session: senderSession.id });
  const entry = entries.find((e) => "response" in e);
  if (!entry || !("response" in entry)) return assert.fail("expected a response entry");
  void resolved;

  const senderAgent = new Agent({
    callbackUrl: "https://overseer.example/r",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${SENDER}`,
    session: senderSession.id,
  });
  // A response ENTRY declaring a pre-0.5 version is malformed for the mailbox union (delivery
  // requires a registered submitting session, a >= 0.5 feature) — the resource schema alone would
  // have accepted it.
  const downgraded = { ...entry.response, ma2h_version: "0.4" as const };
  const res = senderAgent.receiveResponseEntry(downgraded, entry.signature, now.t);
  assert.equal(res.acted, false);
  assert.match(res.acted === false ? res.reason : "", /invalid response entry/);
});

// ---- codex round 3 #3: the human task-resolution path carries the checklist ----

test("a human task resolve carries the final checklist into the Response (§6/§8.8)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const task = {
    ma2h_version: "0.5" as const,
    type: "task" as const,
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_01", runtime: "cli" as const },
    title: "Rotate the key",
    idempotency_key: "rot",
    action: { instructions: "rotate", checklist: [{ text: "rotate", done: false }] },
  };
  const { id } = hub.submit(task);
  const out = hub.resolve(id, {
    actor: `agent:${SENDER}`,
    resolution: "completed",
    checklist: [{ text: "rotate", done: true }],
  });
  assert.deepEqual(out.response?.checklist, [{ text: "rotate", done: true }]);
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
