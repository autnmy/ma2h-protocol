// Acknowledgment / receipt (spec §14, v0.4) — Hub ackMessage (response leg) + ackInbox note (directive
// leg), the delivery track, and the §14.4 pushed-ack signature.

import test from "node:test";
import assert from "node:assert/strict";
import { Hub, HubError } from "../src/hub.js";
import { parseSignatureHeader } from "../src/agent.js";
import { buildAckSignedContext, computeAckSha256, verifyAck } from "../src/signing.js";
import type { A2hMessage, DirectiveTo } from "../src/types.js";

const KEY = "hub-ack-key-0123456789abcdef0123456789abcdef";
const T0 = 1_782_056_000_000;
const AGENT = "deploybot/dev-team";

function newHub(now: { t: number }): Hub {
  return new Hub({ signingKey: KEY, now: () => now.t });
}

function ask(): A2hMessage {
  return {
    ma2h_version: "0.4",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: AGENT, run_id: "run_1", runtime: "github-actions" },
    title: "Ship the release?",
    idempotency_key: "k1",
    request: {
      mode: "select",
      options: [
        { value: "ship", label: "Ship" },
        { value: "hold", label: "Hold" },
      ],
      allowed_resolvers: ["human:you"],
    },
  };
}

test("response-leg ack: answered → delivered-to-agent (on GET) → acknowledged (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });

  // The submitting agent GETs its resolved message → delivered-to-agent.
  const got = hub.get(id, AGENT);
  assert.equal(got?.delivery?.state, "delivered-to-agent");

  const ack = hub.ackMessage(id, AGENT, { note: "got your Ship it — resuming the deploy" });
  assert.equal(ack.type, "ack");
  assert.equal(ack.in_reply_to, id);
  assert.equal(ack.by, `agent:${AGENT}`);
  assert.equal(ack.note, "got your Ship it — resuming the deploy");

  const after = hub.get(id, AGENT);
  assert.equal(after?.delivery?.state, "acknowledged");
  assert.deepEqual(after?.delivery?.ack, ack);
});

test("ack is submitter-bound: a foreign agent cannot ack another's message (§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });
  assert.throws(() => hub.ackMessage(id, "other/agent"), (e: unknown) => e instanceof HubError && e.code === "not_found");
});

test("ack requires a terminal message: acking an open ask is refused (§14.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask()); // still open
  assert.throws(
    () => hub.ackMessage(id, AGENT),
    (e: unknown) => e instanceof HubError && e.code === "not_acknowledgeable",
  );
});

test("ack is refused before the response is delivered to the agent (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });
  // Terminal, but the agent has not fetched it (no push/GET) → not yet delivered-to-agent.
  assert.throws(
    () => hub.ackMessage(id, AGENT),
    (e: unknown) => e instanceof HubError && e.code === "not_acknowledgeable",
  );
});

test("first-ack-wins: a repeat ack returns the existing ack (§14.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });
  hub.get(id, AGENT); // agent receives the answer → delivered-to-agent
  const first = hub.ackMessage(id, AGENT, { note: "first" });
  now.t += 5000;
  const second = hub.ackMessage(id, AGENT, { note: "second" });
  assert.deepEqual(second, first, "the first ack is immutable");
});

test("the Hub stamps the authoritative resolution_id on a response-leg ack (§14.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });
  const stored = hub.get(id, AGENT); // the message's real resolution_id
  const ack = hub.ackMessage(id, AGENT);
  assert.equal(ack.resolution_id, stored?.response?.resolution_id, "ack carries the message's real resolution_id");
});

test("directive-leg ack: the mailbox consume folds the receipt with an optional note (§14.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: `agent:${AGENT}` as DirectiveTo, title: "Freeze deploys" });
  hub.drainInbox(AGENT);
  const { acked, acks } = hub.ackInbox(AGENT, [id], { note: "got it, on it" });
  assert.equal(acked, 1);
  assert.equal(acks.length, 1);
  assert.equal(acks[0]!.in_reply_to, id);
  assert.equal(acks[0]!.by, `agent:${AGENT}`);
  assert.equal(acks[0]!.note, "got it, on it");
});

test("directive receipt persists after the mailbox record is compacted (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: `agent:${AGENT}` as DirectiveTo, title: "hold" });
  assert.equal(hub.getDelivery(id, "human:alice")?.state, "queued");
  hub.drainInbox(AGENT);
  assert.equal(hub.getDelivery(id, "human:alice")?.state, "delivered");
  hub.ackInbox(AGENT, [id], { note: "on it" });
  // The mailbox record is gone, but the human-facing receipt survives.
  const d = hub.getDelivery(id, "human:alice");
  assert.equal(d?.state, "acknowledged");
  assert.equal(d?.ack?.note, "on it");
  assert.equal(hub.drainInbox(AGENT).length, 0, "the acked directive is not redelivered");
});

test("directive ack is idempotent: a re-ack returns the existing receipt from deliveries (§14.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: `agent:${AGENT}` as DirectiveTo, title: "hold" });
  hub.drainInbox(AGENT);
  const first = hub.ackInbox(AGENT, [id], { note: "on it" });
  assert.equal(first.acked, 1);
  // The record is compacted; a retry recovers the same immutable ack (not an empty result).
  const retry = hub.ackInbox(AGENT, [id]);
  assert.equal(retry.acked, 0, "nothing newly acked");
  assert.deepEqual(retry.acks, [first.acks[0]], "the existing receipt is returned");
});

test("acking an un-drained (queued) directive is a no-op — no fabricated receipt (§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: `agent:${AGENT}` as DirectiveTo, title: "hold" });
  // Skip the drain and try to ack directly.
  const res = hub.ackInbox(AGENT, [id], { note: "sneaky" });
  assert.equal(res.acked, 0);
  assert.equal(res.acks.length, 0);
  assert.equal(hub.getDelivery(id, "human:alice")?.state, "queued", "still only queued — no acknowledged receipt");
  assert.equal(hub.drainInbox(AGENT).length, 1, "and it is still deliverable");
});

test("an expired directive's receipt advances to `expired`, not a stuck `queued` (§13.3/§14.2)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({
    from: "human:alice",
    to: `agent:${AGENT}` as DirectiveTo,
    title: "stale",
    expires_at: new Date(T0 + 1_000).toISOString(),
  });
  assert.equal(hub.getDelivery(id, "human:alice")?.state, "queued");
  now.t = T0 + 5_000; // past expiry
  hub.drainInbox(AGENT); // the drain sweeps the expired record
  assert.equal(hub.getDelivery(id, "human:alice")?.state, "expired");
});

test("pushed-ack signature (§14.4) verifies; a tampered note fails", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });
  hub.get(id, AGENT); // delivered-to-agent
  const ack = hub.ackMessage(id, AGENT, { note: "resuming" });

  const header = hub.signAckForPush(ack, now.t);
  const sig = parseSignatureHeader(header);
  const scOf = (a: typeof ack) =>
    buildAckSignedContext({ ack_sha256: computeAckSha256(a), by: a.by, in_reply_to: a.in_reply_to, jti: sig.jti, ma2h_version: a.ma2h_version, t: sig.t });

  assert.ok(verifyAck(scOf(ack), sig.v1, { key: KEY, now: now.t }).ok, "honest ack verifies");
  const tampered = { ...ack, note: "HOLD — do not deploy" };
  const res = verifyAck(scOf(tampered), sig.v1, { key: KEY, now: now.t });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "signature mismatch");
});

test("inbox-ack never surfaces a response-leg ack — the two ack APIs stay disjoint (§14.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id: msgId } = hub.submit(ask());
  hub.resolve(msgId, { actor: "human:you", resolution: "answered", value: "ship" });
  hub.get(msgId, AGENT);
  hub.ackMessage(msgId, AGENT); // this message is now acknowledged by agent:AGENT
  // A /v1/inbox/ack with the msg_ id (never in the mailbox) must be a pure no-op, not return the response ack.
  const res = hub.ackInbox(AGENT, [msgId]);
  assert.equal(res.acked, 0);
  assert.deepEqual(res.acks, []);
});

test("receipt reads are owner-only: a non-owner gets undefined (§14.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: `agent:${AGENT}` as DirectiveTo, title: "hold" });
  hub.drainInbox(AGENT);
  hub.ackInbox(AGENT, [id], { note: "on it" });
  assert.equal(hub.getDelivery(id, "human:alice")?.state, "acknowledged", "the owner reads the receipt");
  assert.equal(hub.getDelivery(id, "human:eve"), undefined, "a non-owner reads nothing");
});
