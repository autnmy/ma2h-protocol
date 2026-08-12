// The v0.5 inter-agent leg (spec §4, §5.1, §6, §7, §8.1, §8.7.1, §8.8, §14.2, §15.1):
// submit-time destination validation, addressed routing into the mailbox with the attested
// delivered form, the REQUIRED reachability snapshot, session-scoped drain filtering,
// first-claim-wins claims, per-kind acks on the pinned ack keys, delivery-track truthfulness
// (incl. stream provisionality), bounce-on-terminal with receipts + auto-resolutions, retention
// terminals, and the §8.8 resolve binding with the v0.5 resolver-authz rules.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hub, HubError } from "../src/hub.js";
import { Agent } from "../src/agent.js";
import type { A2hMessage, AskMessage, InboxEntryDelivery, TaskMessage } from "../src/types.js";

const KEY = "hub-interagent-key-0123456789abcdef0123456789ab";
const T0 = 1_786_752_000_000;
const SENDER = "overseer/fleet";
const WORKER = "deploybot/dev-team";
const OWNER = "human:you";

function newHub(now: { t: number }, opts?: { sessionVisibility?: boolean; retentionDays?: number }): Hub {
  const hub = new Hub({
    signingKey: KEY,
    now: () => now.t,
    visibilityTimeoutSeconds: 60,
    presenceFreshnessSeconds: 90,
    sessionMinTtlSeconds: 60,
    ...(opts?.sessionVisibility !== undefined ? { sessionVisibility: opts.sessionVisibility } : {}),
    ...(opts?.retentionDays !== undefined ? { retentionDays: opts.retentionDays } : {}),
  });
  hub.setAgentOwner(SENDER, OWNER);
  hub.setAgentOwner(WORKER, OWNER);
  return hub;
}

function ask(over: { to?: string; session?: string; state?: Record<string, never> } & Partial<AskMessage> = {}): AskMessage {
  const { to, session, ...rest } = over;
  return {
    ma2h_version: "0.5",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_01", runtime: "cli", ...(session !== undefined ? { session } : {}) },
    ...(to !== undefined ? { to: to as AskMessage["to"] } : {}),
    title: "May I restart your queue consumer?",
    idempotency_key: "restart-consumer-1",
    request: { mode: "confirm" },
    ...rest,
  } as AskMessage;
}

function notify(over: { to?: string; session?: string } = {}): A2hMessage {
  return {
    ma2h_version: "0.5",
    type: "notify",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_01", runtime: "cli", ...(over.session !== undefined ? { session: over.session } : {}) },
    ...(over.to !== undefined ? { to: over.to as A2hMessage["to"] } : {}),
    title: "Deploy finished",
  } as A2hMessage;
}

function newWorkerAgent(session?: string, senderPolicy?: string[] | "any-same-account"): Agent {
  return new Agent({
    callbackUrl: "https://worker.example/resume",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${WORKER}`,
    ...(session !== undefined ? { session } : {}),
    ...(senderPolicy !== undefined ? { senderPolicy } : {}),
  });
}

// ---- §4 submit-time destination validation ----

test("unknown destination, cross-account, and allowlist-blocked all collapse to 422 unknown_destination (§4/§8.5)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const is = (code: string) => (e: unknown) => e instanceof HubError && e.code === code;
  // Unknown principal.
  assert.throws(() => hub.submit(ask({ to: "agent:nobody/here" })), is("unknown_destination"));
  // Cross-account: provisioned under a DIFFERENT owner — indistinguishable from unknown.
  hub.setAgentOwner("rival/agent", "human:someone-else");
  assert.throws(() => hub.submit(ask({ to: "agent:rival/agent" })), is("unknown_destination"));
  // Unknown session of a known principal.
  assert.throws(() => hub.submit(ask({ to: `agent:${WORKER}#sess_nope` })), is("unknown_destination"));
  // Sender-allowlist block reads exactly the same (§8.5 — no enumeration oracle).
  hub.setSenderAllowlist(WORKER, ["someone/else"]);
  assert.throws(() => hub.submit(ask({ to: `agent:${WORKER}` })), is("unknown_destination"));
  hub.setSenderAllowlist(WORKER, null);
  assert.equal(hub.submit(ask({ to: `agent:${WORKER}` })).status, "open");
});

test("an own-account TERMINAL destination session is 410 destination_gone — collapsed to 422 without visibility (§4/§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(WORKER);
  hub.closeSession(session.id, WORKER);
  assert.throws(
    () => hub.submit(ask({ to: `agent:${WORKER}#${session.id}` })),
    (e: unknown) => e instanceof HubError && e.code === "destination_gone",
  );
  // Visibility off (§16.4 policy): the split MUST collapse — terminal reads as unknown.
  const blind = newHub(now, { sessionVisibility: false });
  const dead = blind.registerSession(WORKER).session;
  blind.closeSession(dead.id, WORKER);
  assert.throws(
    () => blind.submit(ask({ to: `agent:${WORKER}#${dead.id}` })),
    (e: unknown) => e instanceof HubError && e.code === "unknown_destination",
  );
});

test("sender-side symmetry: a #-bearing submitter cannot send addressed mail, but its human-inbox traffic is unaffected (§4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.setAgentOwner("we#ird", OWNER);
  const weird = ask({ to: `agent:${WORKER}` });
  weird.agent.id = "we#ird";
  assert.throws(
    () => hub.submit(weird),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );
  const plain = ask();
  plain.agent.id = "we#ird";
  assert.equal(hub.submit(plain).status, "open", "the human-inbox path is unaffected");
});

test("`to`/`agent.session` on a pre-0.5 envelope are rejected, not silently misrouted (§4/§10)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const old = ask({ to: `agent:${WORKER}` });
  (old as { ma2h_version: string }).ma2h_version = "0.4";
  assert.throws(
    () => hub.submit(old),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );
});

test("agent.session must be an OWN live session: foreign/unknown 422, own-terminal 410; naming it renews the lease (§4.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const foreign = hub.registerSession(WORKER).session; // someone else's session
  assert.throws(
    () => hub.submit(ask({ to: `agent:${WORKER}`, session: foreign.id })),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );
  const own = hub.registerSession(SENDER, { ttl_seconds: 900 }).session;
  hub.closeSession(own.id, SENDER);
  assert.throws(
    () => hub.submit(ask({ to: `agent:${WORKER}`, session: own.id })),
    (e: unknown) => e instanceof HubError && e.code === "destination_gone",
  );
  const live = hub.registerSession(SENDER, { ttl_seconds: 900 }).session;
  now.t = T0 + 100_000;
  hub.submit(ask({ to: `agent:${WORKER}`, session: live.id }));
  assert.equal(
    Date.parse(hub.getSession(live.id, SENDER).session.expires_at),
    now.t + 900_000,
    "the submit renewed the named session's lease (§16.2)",
  );
});

// ---- §8.1 the addressed ack: owning-track status + the REQUIRED destination snapshot ----

test("addressed acks carry the owning track's status plus the REQUIRED destination snapshot; human-inbox acks carry none (§8.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.registerSession(WORKER);
  const askAck = hub.submit(ask({ to: `agent:${WORKER}` }));
  assert.equal(askAck.status, "open", "ask keeps the §7 resolution track");
  assert.equal(askAck.destination?.state, "online");
  const noteAck = hub.submit(notify({ to: `agent:${WORKER}` }));
  assert.equal(noteAck.status, "queued", "an addressed notify is queued, never delivered-at-accept (§5.1)");
  assert.ok(noteAck.destination);
  const human = hub.submit(notify());
  assert.equal(human.status, "delivered");
  assert.equal(human.destination, undefined, "no snapshot on the human-inbox path — the misroute detector");
});

test("the snapshot derives from SESSION-BEARING activity only, gated by the visibility policy (§15.1 split)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  // Never any session: unknown, with NO last_seen.
  const cold = hub.submit(ask({ to: `agent:${WORKER}` }));
  assert.deepEqual(cold.destination, { state: "unknown" });
  // A session-less directive drain is v0.4 presence but NOT v0.5 reachability (§15.1): still unknown.
  hub.drainInbox(WORKER);
  assert.deepEqual(hub.submit(ask({ to: `agent:${WORKER}` })).destination, { state: "unknown" });
  // A live session with fresh session-bearing activity reads online.
  const live = hub.registerSession(WORKER).session;
  const warm = hub.submit(ask({ to: `agent:${WORKER}` }));
  assert.equal(warm.destination?.state, "online");
  assert.equal(warm.destination?.last_seen, new Date(now.t).toISOString());
  // Stale + no live session: offline, last_seen preserved.
  hub.closeSession(live.id, WORKER);
  now.t = T0 + 200_000;
  const stale = hub.submit(ask({ to: `agent:${WORKER}` }));
  assert.equal(stale.destination?.state, "offline");
  // Session-addressed: that session's own last_seen anchors the snapshot.
  const s2 = hub.registerSession(WORKER).session;
  const sessAck = hub.submit(ask({ to: `agent:${WORKER}#${s2.id}` }));
  assert.equal(sessAck.destination?.state, "online");
  assert.equal(sessAck.destination?.last_seen, new Date(now.t).toISOString());
  // Visibility off: exactly { state: "unknown" }, no last_seen — never a presence oracle.
  const blind = newHub(now, { sessionVisibility: false });
  blind.registerSession(WORKER);
  assert.deepEqual(blind.submit(ask({ to: `agent:${WORKER}` })).destination, { state: "unknown" });
});

// ---- §8.7.1 delivered form + session-scoped drain filtering ----

test("the delivered form carries the Hub-attested session-qualified from and strips submitter machinery (§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(SENDER).session;
  const workerSession = hub.registerSession(WORKER).session;
  const submitted = ask({ to: `agent:${WORKER}`, session: senderSession.id });
  (submitted as AskMessage).state = { sealed: "v1.blob" };
  (submitted as AskMessage).client_ref = "corr-1";
  submitted.request.callback = { mode: "push", url: "https://overseer.example/resolve" };
  const { id } = hub.submit(submitted);

  const entries = hub.drainInbox(WORKER, { session: workerSession.id });
  assert.equal(entries.length, 1);
  const entry = entries[0] as Extract<InboxEntryDelivery, { message: unknown }>;
  assert.ok("message" in entry, "delivered as a message entry");
  assert.equal(entry.message.id, id);
  assert.equal(entry.message.from, `agent:${SENDER}#${senderSession.id}`, "attested, session-qualified");
  assert.equal(entry.message.to, `agent:${WORKER}`);
  assert.equal((entry.message as { state?: unknown }).state, undefined, "state stripped");
  assert.equal((entry.message as { client_ref?: unknown }).client_ref, undefined, "client_ref stripped");
  assert.equal(
    (entry.message as AskMessage).request.callback,
    undefined,
    "the submitter's delivery config is stripped",
  );
  assert.equal(entry.message.idempotency_key, "restart-consumer-1", "idempotency_key is delivered (inert)");

  // The §9.8 signature verifies via the consuming agent (recompute-from-received discipline).
  const worker = newWorkerAgent(workerSession.id, [SENDER]);
  const res = worker.receiveMessageEntry(entry.message, entry.signature, now.t);
  assert.equal(res.acted, true);
});

test("a session-less drain returns exactly the v0.4 shape — no v0.5 entry kind ever leaks (§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  hub.submit(ask({ to: `agent:${WORKER}` })); // principal-addressed message entry
  hub.submit(ask({ to: `agent:${WORKER}#${workerSession.id}` })); // session-addressed
  hub.sendDirective({ from: "human:you", to: `agent:${WORKER}#${workerSession.id}`, title: "for that session" });
  hub.sendDirective({ from: "human:you", to: `agent:${WORKER}`, title: "plain v0.4 directive" });

  const v04 = hub.drainInbox(WORKER);
  assert.equal(v04.length, 1, "only the principal-addressed directive");
  assert.ok("directive" in (v04[0] as object));
  assert.equal(v04[0]?.directive.title, "plain v0.4 directive");

  // The session-presenting drain sees the rest.
  const scoped = hub.drainInbox(WORKER, { session: workerSession.id });
  assert.equal(scoped.length, 3, "both message entries + the session-addressed directive");
});

test("foreign/unknown session drains read 404; the caller's own terminal session reads 410 — distinct by design (§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { session } = hub.registerSession(WORKER);
  assert.throws(
    () => hub.drainInbox(SENDER, { session: session.id }),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
    "foreign session: indistinguishable from nonexistent",
  );
  assert.throws(
    () => hub.drainInbox(WORKER, { session: "sess_never" }),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
  );
  hub.closeSession(session.id, WORKER);
  assert.throws(
    () => hub.drainInbox(WORKER, { session: session.id }),
    (e: unknown) => e instanceof HubError && e.code === "gone",
    "own-but-terminal: re-register and continue",
  );
});

test("first-claim-wins: one session claims a principal-addressed entry; the sibling rescues it only after the window (§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const s1 = hub.registerSession(WORKER).session;
  const s2 = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}` }));

  const first = hub.drainInbox(WORKER, { session: s1.id });
  assert.equal(first.length, 1, "s1 claims");
  assert.equal(hub.drainInbox(WORKER, { session: s2.id }).length, 0, "s2 sees nothing inside the window");

  now.t = T0 + 61_000; // visibility window lapses un-acked → sibling rescue
  const rescued = hub.drainInbox(WORKER, { session: s2.id });
  assert.equal(rescued.length, 1, "redelivered to the sibling");
  hub.ackInbox(WORKER, [id], { session: s2.id });
  now.t = T0 + 130_000;
  assert.equal(hub.drainInbox(WORKER, { session: s1.id }).length, 0, "consumed for good");
});

test("session-addressed entries are visible ONLY to drains presenting that session (§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const s1 = hub.registerSession(WORKER).session;
  const s2 = hub.registerSession(WORKER).session;
  hub.submit(ask({ to: `agent:${WORKER}#${s1.id}` }));
  assert.equal(hub.drainInbox(WORKER, { session: s2.id }).length, 0);
  assert.equal(hub.drainInbox(WORKER, { session: s1.id }).length, 1);
});

// ---- §8.7.1 per-kind acks + the sender-authoritative mailbox track ----

test("the mailbox track runs queued → delivered → acknowledged on the sender's GET; an addressed notify's status mirrors it (§5.1/§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(notify({ to: `agent:${WORKER}` }));

  assert.equal(hub.get(id, SENDER)?.mailbox?.state, "queued");
  assert.equal(hub.get(id, SENDER)?.status, "queued");

  now.t = T0 + 10_000;
  hub.drainInbox(WORKER, { session: workerSession.id });
  const delivered = hub.get(id, SENDER);
  assert.equal(delivered?.mailbox?.state, "delivered");
  assert.equal(delivered?.mailbox?.delivered_at, new Date(now.t).toISOString());
  assert.equal(delivered?.status, "delivered");

  now.t = T0 + 20_000;
  hub.ackInbox(WORKER, [id], { session: workerSession.id, note: "seen" });
  const acked = hub.get(id, SENDER);
  assert.equal(acked?.mailbox?.state, "acknowledged");
  assert.equal(acked?.mailbox?.acknowledged_at, new Date(now.t).toISOString());
  assert.equal(acked?.status, "acknowledged");
});

test("acking a never-presented entry is a no-op — no fabricated receipt (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.registerSession(WORKER);
  const { id } = hub.submit(notify({ to: `agent:${WORKER}` }));
  const res = hub.ackInbox(WORKER, [id]);
  assert.equal(res.acked, 0);
  assert.equal(hub.get(id, SENDER)?.mailbox?.state, "queued");
});

test("a response entry's ack advances the response track, first-ack-wins with the §14.3 endpoint (§8.7.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(SENDER).session;
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}`, session: senderSession.id }));
  hub.drainInbox(WORKER, { session: workerSession.id });
  const resolved = hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: workerSession.id });

  // The live submitting session receives the Response as a mailbox entry (§6).
  const entries = hub.drainInbox(SENDER, { session: senderSession.id });
  const entry = entries.find((e) => "response" in e) as Extract<InboxEntryDelivery, { response: unknown }>;
  assert.ok(entry, "response entry delivered to the submitting session");
  assert.equal(entry.response.resolution_id, resolved.resolution_id);

  // Its ack key is the resolution_id; acking it advances the response track to acknowledged.
  const ackRes = hub.ackInbox(SENDER, [resolved.resolution_id], { session: senderSession.id });
  assert.equal(ackRes.acked, 1);
  assert.equal(ackRes.acks[0]?.resolution_id, resolved.resolution_id);
  assert.equal(hub.get(id, SENDER)?.delivery?.state, "acknowledged");

  // The §14.3 endpoint afterwards is the standard idempotent no-op returning the same receipt.
  const repeat = hub.ackMessage(id, SENDER);
  assert.equal(repeat.resolution_id, resolved.resolution_id);
});

// ---- §8.8 resolve binding + §9.1 v0.5 resolver authz ----

test("the addressee resolves an addressed ask (any of its sessions); the submitter and the account human may not (§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}` }));
  // The SUBMITTER of an ask is the one party who must not answer it.
  assert.throws(
    () => hub.resolveAsAgent(id, SENDER, { resolution: "answered", value: "approve" }),
    (e: unknown) => e instanceof HubError && e.code === "not_authorized",
  );
  // The account's human is deliberately NOT a default resolver for agent-addressed messages.
  assert.throws(
    () => hub.resolve(id, { actor: OWNER, resolution: "answered", value: "approve" }),
    (e: unknown) => e instanceof HubError && e.code === "not_authorized",
  );
  // The addressee, presenting its session, is the default resolver; the actor is attested session-qualified.
  const out = hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: workerSession.id });
  assert.equal(out.status, "answered");
  assert.equal(out.response.response?.actor, `agent:${WORKER}#${workerSession.id}`);
  assert.match(out.resolution_id, /^res_/);
});

test("a session-qualified allowed_resolvers entry matches only that exact session; principal-form matches any (§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const sA = hub.registerSession(WORKER).session;
  const sB = hub.registerSession(WORKER).session;
  const restricted = ask({ to: `agent:${WORKER}` });
  restricted.request.allowed_resolvers = [`agent:${WORKER}#${sA.id}`];
  const { id } = hub.submit(restricted);
  assert.throws(
    () => hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: sB.id }),
    (e: unknown) => e instanceof HubError && e.code === "not_authorized",
    "the sibling session does not match a session-qualified entry",
  );
  assert.throws(
    () => hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }),
    (e: unknown) => e instanceof HubError && e.code === "not_authorized",
    "the bare principal does not match a session-qualified entry",
  );
  const ok = hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: sA.id });
  assert.equal(ok.status, "answered");

  // Principal-form entry: any session of that principal matches (the qualifier is ignored).
  const open2 = ask({ to: `agent:${WORKER}` });
  open2.request.allowed_resolvers = [`agent:${WORKER}`];
  const { id: id2 } = hub.submit(open2);
  assert.equal(
    hub.resolveAsAgent(id2, WORKER, { resolution: "answered", value: "approve" }, { session: sB.id }).status,
    "answered",
  );
});

test("resolve validation: verb mismatch and bad option values are 422; malformed bodies are validation errors (§8.8)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.registerSession(WORKER);
  const { id } = hub.submit(ask({ to: `agent:${WORKER}` }));
  const is = (code: string) => (e: unknown) => e instanceof HubError && e.code === code;
  assert.throws(() => hub.resolveAsAgent(id, WORKER, { resolution: "completed" }), is("invalid_field"), "task verb on an ask");
  assert.throws(
    () => hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "maybe" }),
    is("invalid_field"),
    "a confirm answer must be approve|deny (§5.2)",
  );
  assert.throws(
    () =>
      hub.resolveAsAgent(id, WORKER, { resolution: "declined", value: "approve" } as Parameters<Hub["resolveAsAgent"]>[2]),
    is("validation_error"),
    "value MUST NOT appear for a non-answered resolution (schema-enforced)",
  );
  assert.throws(
    () => hub.resolveAsAgent(id, WORKER, { resolution: "answered" }),
    is("validation_error"),
    "value REQUIRED for answered (schema-enforced)",
  );
});

test("a resolve after a terminal is 409 already_terminal carrying the real outcome; expiry beats a late resolve (§7/§8.8)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}` }));
  hub.resolveAsAgent(id, WORKER, { resolution: "declined" }, { session: workerSession.id });
  try {
    hub.resolveAsAgent(id, WORKER, { resolution: "answered", value: "approve" }, { session: workerSession.id });
    assert.fail("expected already_terminal");
  } catch (e) {
    assert.ok(e instanceof HubError && e.code === "already_terminal");
    assert.equal((e.details as { resolution?: string }).resolution, "declined", "the caller reads the real outcome");
  }

  // Expiry-vs-answer on the same clock: a late resolve loses to the default expiry.
  const expiring = ask({ to: `agent:${WORKER}` });
  expiring.expires_at = new Date(T0 + 50_000).toISOString();
  expiring.request.default_on_expire = "deny";
  const { id: id2 } = hub.submit(expiring);
  now.t = T0 + 60_000;
  try {
    hub.resolveAsAgent(id2, WORKER, { resolution: "answered", value: "approve" }, { session: workerSession.id });
    assert.fail("expected already_terminal");
  } catch (e) {
    assert.ok(e instanceof HubError && e.code === "already_terminal");
    assert.equal((e.details as { resolution?: string }).resolution, "expired");
  }
  assert.equal(hub.get(id2, SENDER)?.response?.response?.value, "deny", "default_on_expire applied");
});

test("a task resolve carries the final checklist into the Response (§5.3/§8.8)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const task: TaskMessage = {
    ma2h_version: "0.5",
    type: "task",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_01", runtime: "cli" },
    to: `agent:${WORKER}`,
    title: "Rotate the shared key",
    idempotency_key: "rotate-1",
    action: { instructions: "Rotate it", checklist: [{ text: "rotate", done: false }] },
  };
  const { id } = hub.submit(task);
  const out = hub.resolveAsAgent(
    id,
    WORKER,
    { resolution: "completed", comment: "done", checklist: [{ text: "rotate", done: true }] },
    { session: workerSession.id },
  );
  assert.deepEqual(out.response.response?.checklist, [{ text: "rotate", done: true }]);
  assert.equal(out.response.response?.comment, "done");
});

// ---- §14.2 bounce-on-terminal + receipts + auto-resolutions ----

test("closing a session bounces its queued session-addressed ask: prior queued, auto-cancel by system:undeliverable, receipt to the sender (§14.2/§16.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(SENDER).session;
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}#${workerSession.id}`, session: senderSession.id }));

  now.t = T0 + 10_000;
  hub.closeSession(workerSession.id, OWNER); // the operator kill-switch (§16.4)

  // Sender's authoritative pull: bounced, never delivered; the ask auto-resolved cancelled.
  const got = hub.get(id, SENDER);
  assert.equal(got?.mailbox?.state, "bounced");
  assert.equal(got?.mailbox?.delivered_at, undefined, "never seen");
  assert.equal(got?.status, "cancelled");
  assert.equal(got?.response?.response?.actor, "system:undeliverable");

  // The sender's live session holds BOTH the auto-cancellation response entry and the bounce
  // receipt for the same in_reply_to — distinct ack keys (§8.7.1).
  const entries = hub.drainInbox(SENDER, { session: senderSession.id });
  const receiptEntry = entries.find((e) => "receipt" in e) as Extract<InboxEntryDelivery, { receipt: unknown }>;
  const responseEntry = entries.find((e) => "response" in e) as Extract<InboxEntryDelivery, { response: unknown }>;
  assert.ok(receiptEntry, "bounce receipt delivered");
  assert.ok(responseEntry, "auto-cancellation response delivered");
  assert.equal(receiptEntry.receipt.in_reply_to, id);
  assert.equal(responseEntry.response.in_reply_to, id);
  assert.equal(receiptEntry.receipt.prior, "queued");
  assert.equal(receiptEntry.receipt.session, workerSession.id);
  assert.match(receiptEntry.receipt.id, /^rcpt_/);

  // The receipt verifies §9.8 on the sender side and dedups on (in_reply_to, event).
  const senderAgent = new Agent({
    callbackUrl: "https://overseer.example/resume",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${SENDER}`,
    session: senderSession.id,
  });
  const r1 = senderAgent.receiveReceipt(receiptEntry.receipt, receiptEntry.signature, now.t);
  assert.equal(r1.acted, true);
  const r2 = senderAgent.receiveReceipt(receiptEntry.receipt, receiptEntry.signature, now.t);
  assert.equal(r2.acted, false, "duplicate receipt refused");
});

test("a drained-but-unacked entry bounces prior:delivered (seen-then-orphaned) when its session dies (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(SENDER).session;
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}#${workerSession.id}`, session: senderSession.id }));
  now.t = T0 + 5_000;
  hub.drainInbox(WORKER, { session: workerSession.id }); // drained, never acked — the §13.4 crash window
  now.t = T0 + 10_000;
  hub.closeSession(workerSession.id, WORKER);
  const got = hub.get(id, SENDER);
  assert.equal(got?.mailbox?.state, "bounced");
  assert.equal(got?.mailbox?.delivered_at, new Date(T0 + 5_000).toISOString(), "the delivery is preserved");
  const entries = hub.drainInbox(SENDER, { session: senderSession.id });
  const receiptEntry = entries.find((e) => "receipt" in e) as Extract<InboxEntryDelivery, { receipt: unknown }>;
  assert.equal(receiptEntry.receipt.prior, "delivered");
});

test("a principal-addressed claim does NOT bounce on the claimant's death — the sibling rescues it (§8.7.1/§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const s1 = hub.registerSession(WORKER).session;
  const s2 = hub.registerSession(WORKER).session;
  const { id } = hub.submit(ask({ to: `agent:${WORKER}` }));
  hub.drainInbox(WORKER, { session: s1.id }); // s1 claims
  hub.closeSession(s1.id, WORKER); // claimant dies mid-processing
  assert.equal(hub.get(id, SENDER)?.mailbox?.state, "delivered", "no bounce — rescue is possible");
  now.t = T0 + 61_000; // past the visibility window
  const rescued = hub.drainInbox(WORKER, { session: s2.id });
  assert.equal(rescued.length, 1, "ordinary visibility-timeout redelivery to the sibling");
});

test("an addressed notify bounce touches no resolution track; the sender session gone means receipt-less but still truthful (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(notify({ to: `agent:${WORKER}#${workerSession.id}` })); // sender named NO session
  hub.closeSession(workerSession.id, WORKER);
  const got = hub.get(id, SENDER);
  assert.equal(got?.status, "bounced", "the notify lifecycle IS the delivery track (§5.1)");
  assert.equal(got?.response, undefined, "no resolution track on a notify");
  assert.equal(got?.mailbox?.state, "bounced");
});

// ---- retention terminals (§14.2) ----

test("retention: a queued entry expires (never delivered) and auto-resolves; a delivered orphan bounces prior:delivered (§14.2)", () => {
  const now = { t: T0 };
  const hub2 = newHub(now, { retentionDays: 1 });
  const sender2 = hub2.registerSession(SENDER, { ttl_seconds: 3600 }).session;
  const worker2 = hub2.registerSession(WORKER, { ttl_seconds: 3600 }).session;
  const first = hub2.submit(ask({ to: `agent:${WORKER}`, session: sender2.id })); // will be claimed
  hub2.drainInbox(WORKER, { session: worker2.id }); // claims `first`, never acks
  const second = hub2.submit(ask({ to: `agent:${WORKER}`, session: sender2.id })); // stays queued

  now.t = T0 + 2 * 86_400_000; // past retention (sessions kept alive is irrelevant — leases lapsed)
  hub2.sweepRetention();

  const orphaned = hub2.get(first.id, SENDER);
  assert.equal(orphaned?.mailbox?.state, "bounced", "delivered-but-unacked at retention = seen-then-orphaned");
  assert.equal(orphaned?.status, "cancelled");
  const expired = hub2.get(second.id, SENDER);
  assert.equal(expired?.mailbox?.state, "expired", "queued at retention = never delivered");
  assert.equal(expired?.status, "cancelled", "delivery-track expiry auto-resolves like a bounce (§7)");
  assert.equal(expired?.response?.response?.actor, "system:undeliverable");
});

test("retention: a resolved-but-never-pulled answer terminates the response track expired — never rewriting delivered-to-agent (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now, { retentionDays: 1 });
  hub.registerSession(WORKER);
  // Unaddressed ask, resolved by the human — the v0.4 response leg.
  const plain = ask();
  const { id } = hub.submit(plain);
  hub.resolve(id, { actor: `agent:${SENDER}`, resolution: "declined" });
  const pulled = ask();
  pulled.idempotency_key = "other-key";
  const { id: id2 } = hub.submit(pulled);
  hub.resolve(id2, { actor: `agent:${SENDER}`, resolution: "declined" });
  hub.get(id2, SENDER); // the submitter DID pull this one → delivered-to-agent

  now.t = T0 + 2 * 86_400_000;
  hub.sweepRetention();
  assert.equal(hub.get(id, SENDER)?.delivery?.state, "expired", "never seen");
  assert.equal(hub.get(id2, SENDER)?.delivery?.state, "delivered-to-agent", "a reached state is never rewritten");
});

// ---- §8.7.2 stream provisionality ----

test("a stream push is provisional: the track stays queued until the ack (which stamps delivery), and an unacked claim reverts (§8.7.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const workerSession = hub.registerSession(WORKER).session;
  const { id } = hub.submit(notify({ to: `agent:${WORKER}` }));

  const pushed = hub.streamClaim(WORKER, workerSession.id);
  assert.equal(pushed.length, 1, "the stream delivered the entry");
  assert.equal(hub.get(id, SENDER)?.mailbox?.state, "queued", "a server-originated push is NOT delivery evidence");

  // Unacked: reverts to queued-visible after the visibility window — at-least-once preserved.
  now.t = T0 + 61_000;
  const redelivered = hub.drainInbox(WORKER, { session: workerSession.id });
  assert.equal(redelivered.length, 1, "reverted and drained");
  assert.equal(hub.get(id, SENDER)?.mailbox?.state, "delivered", "the DRAIN stamped delivery");

  // A second stream push whose ACK is the first client-originated evidence.
  const { id: id2 } = hub.submit(notify({ to: `agent:${WORKER}` }));
  hub.streamClaim(WORKER, workerSession.id, { now: now.t });
  hub.ackInbox(WORKER, [id2], { session: workerSession.id, now: now.t });
  const acked = hub.get(id2, SENDER);
  assert.equal(acked?.mailbox?.state, "acknowledged", "the ack advanced the track (§8.7.2)");
  assert.equal(acked?.mailbox?.delivered_at, new Date(now.t).toISOString(), "delivery stamped at ack time");
});
