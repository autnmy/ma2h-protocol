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

test("first-ack-wins: a repeat ack returns the existing ack (§14.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });
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
  assert.equal(hub.getDirectiveDelivery(id)?.state, "queued");
  hub.drainInbox(AGENT);
  assert.equal(hub.getDirectiveDelivery(id)?.state, "delivered");
  hub.ackInbox(AGENT, [id], { note: "on it" });
  // The mailbox record is gone, but the human-facing receipt survives.
  const d = hub.getDirectiveDelivery(id);
  assert.equal(d?.state, "acknowledged");
  assert.equal(d?.ack?.note, "on it");
  assert.equal(hub.drainInbox(AGENT).length, 0, "the acked directive is not redelivered");
});

test("pushed-ack signature (§14.4) verifies; a tampered note fails", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(ask());
  hub.resolve(id, { actor: "human:you", resolution: "answered", value: "ship" });
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
