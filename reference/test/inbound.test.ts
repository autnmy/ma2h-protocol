// Inbound leg — human → agent directives (spec §8.7, §9.7, §13, v0.4).
//
// Exercises the Hub mailbox (enqueue / drain / ack, at-least-once redelivery, FIFO, isolation,
// expiry) and the agent's receiveDirective (verify §9.7 signature, dedup on id, reject tamper).

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hub, HubError } from "../src/hub.js";
import { Agent } from "../src/agent.js";
import { computeDirectivePayloadSha256 } from "../src/signing.js";
import type { DirectiveTo } from "../src/types.js";

const KEY = "hub-directive-key-0123456789abcdef0123456789abcdef";
const T0 = 1_782_043_200_000; // fixed base; ms

function newHub(now: { t: number }): Hub {
  return new Hub({ signingKey: KEY, now: () => now.t, visibilityTimeoutSeconds: 60 });
}

const AGENT_A = "deploybot/dev-team";
const TO_A = `agent:${AGENT_A}` as DirectiveTo;

function newAgent(agentId: DirectiveTo = TO_A): Agent {
  // directiveKey defaults to callbackKey; here they share the Hub key (§9.7 allows same).
  return new Agent({ callbackUrl: "https://agent.example/resume", callbackKey: KEY, sealKey: randomBytes(32), agentId });
}

test("send → drain → verify §9.7 signature → the agent acts", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  const { id } = hub.sendDirective({ from: "human:alice", to: TO_A, title: "Freeze deploys", priority: "urgent" });

  const [delivery] = hub.drainInbox(AGENT_A);
  assert.ok(delivery, "one directive drained");
  assert.equal(delivery.directive.id, id);
  const res = agent.receiveDirective(delivery.directive, delivery.signature, now.t);
  assert.ok(res.acted, "verified + acted");
  assert.equal(res.acted && res.directive.title, "Freeze deploys");
});

test("at-least-once: an unacked directive is redelivered after the visibility window", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });

  const first = hub.drainInbox(AGENT_A);
  assert.equal(first.length, 1, "delivered once");
  // Within the visibility window it is hidden.
  assert.equal(hub.drainInbox(AGENT_A).length, 0, "hidden within visibility window");
  // After the window it reappears (same id).
  now.t += 61_000;
  const redelivered = hub.drainInbox(AGENT_A);
  assert.equal(redelivered.length, 1, "redelivered after window");
  assert.equal(redelivered[0]!.directive.id, id, "same directive id");
});

test("dedup: the agent acts at most once on a redelivered directive", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });

  const d1 = hub.drainInbox(AGENT_A)[0]!;
  const r1 = agent.receiveDirective(d1.directive, d1.signature, now.t);
  assert.ok(r1.acted, "first delivery acted");
  if (r1.acted) r1.commit(); // record the id only after (modelled) durable processing

  now.t += 61_000;
  const d2 = hub.drainInbox(AGENT_A)[0]!; // redelivered (fresh signature)
  assert.notEqual(d2.signature, d1.signature, "each delivery is re-signed (fresh t/jti)");
  const r2 = agent.receiveDirective(d2.directive, d2.signature, now.t);
  assert.equal(r2.acted, false, "a committed directive is deduped on redelivery by its id");
});

test("deferred dedup: WITHOUT commit(), a redelivery is re-acted (at-least-once tolerance, §13.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });

  const d1 = hub.drainInbox(AGENT_A)[0]!;
  const r1 = agent.receiveDirective(d1.directive, d1.signature, now.t);
  assert.ok(r1.acted, "first delivery acted");
  // The caller "crashes" before commit()/ack — the id is NOT recorded.
  now.t += 61_000;
  const d2 = hub.drainInbox(AGENT_A)[0]!; // redelivered (fresh jti)
  const r2 = agent.receiveDirective(d2.directive, d2.signature, now.t);
  assert.ok(r2.acted, "an uncommitted directive is re-acted on redelivery, not silently dropped");
});

test("ack consumes: an acked directive is not redelivered", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });

  hub.drainInbox(AGENT_A);
  const { acked } = hub.ackInbox(AGENT_A, [id]);
  assert.equal(acked, 1);
  now.t += 120_000; // well past the visibility window
  assert.equal(hub.drainInbox(AGENT_A).length, 0, "acked directive never redelivered");
});

test("isolation: an agent cannot drain or ack another agent's mailbox (§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.sendDirective({ from: "human:alice", to: TO_A, title: "for A only" });

  assert.equal(hub.drainInbox("other/agent").length, 0, "B sees nothing of A's mailbox");
  const ackByB = hub.ackInbox("other/agent", [id]);
  assert.equal(ackByB.acked, 0, "B's ack of A's id is a no-op");
  // A's directive is untouched and still drainable by A.
  assert.equal(hub.drainInbox(AGENT_A).length, 1, "A's directive intact after B's attempt");
});

test("FIFO on first delivery", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const a = hub.sendDirective({ from: "human:alice", to: TO_A, title: "first" });
  const b = hub.sendDirective({ from: "human:alice", to: TO_A, title: "second" });
  const drained = hub.drainInbox(AGENT_A);
  assert.deepEqual(
    drained.map((d) => d.directive.id),
    [a.id, b.id],
    "delivered in submit order",
  );
});

test("expiry: a directive past expires_at is dropped, never delivered (§13.3)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.sendDirective({
    from: "human:alice",
    to: TO_A,
    title: "stale",
    expires_at: new Date(T0 + 1_000).toISOString(),
  });
  now.t = T0 + 5_000; // past expiry
  assert.equal(hub.drainInbox(AGENT_A).length, 0, "expired directive is not delivered");
});

test("tamper: a body altered in transit fails signature verification (§9.7)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold", body: "original" });
  const [d] = hub.drainInbox(AGENT_A);
  const tampered = { ...d!.directive, body: "malicious override" };
  const res = agent.receiveDirective(tampered, d!.signature, now.t);
  assert.equal(res.acted, false);
  assert.equal(res.acted === false && res.reason, "signature: signature mismatch");
});

test("replay window: a directive resting past the window fails unless re-signed", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });
  const [d] = hub.drainInbox(AGENT_A); // signed at T0

  // Agent verifies far in the future against the delivery's t → outside window.
  const late = agent.receiveDirective(d!.directive, d!.signature, T0 + 10_000_000);
  assert.equal(late.acted, false);
  assert.equal(late.acted === false && late.reason, "signature: outside replay window");
});

test("addressee check: a directive validly signed for agent:X is refused by agent:Y (§13.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "for A only" });
  const [d] = hub.drainInbox(AGENT_A); // a genuine, in-window signature for agent:deploybot/dev-team

  // A DIFFERENT agent (its own identity is agent:other/y) receives the same valid delivery. The
  // signature verifies (same Hub key), but the addressee check MUST refuse it — this is the
  // cross-agent-replay defense on the webhook channel, where no Hub-side mailbox gate applies.
  const agentY = newAgent("agent:other/y" as DirectiveTo);
  const res = agentY.receiveDirective(d!.directive, d!.signature, now.t);
  assert.equal(res.acted, false);
  assert.equal(res.acted === false && res.reason, "addressee mismatch: directive.to agent:deploybot/dev-team != agent:other/y");
});

test("jti replay: replaying the exact same signed delivery is rejected (§9.7)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });
  const [d] = hub.drainInbox(AGENT_A);

  assert.ok(agent.receiveDirective(d!.directive, d!.signature, now.t).acted, "first accepted");
  // Same directive AND same signature bytes (same jti) replayed → caught by the jti cache first.
  const replay = agent.receiveDirective(d!.directive, d!.signature, now.t);
  assert.equal(replay.acted, false);
  assert.equal(replay.acted === false && replay.reason, "replay: jti already seen");
});

test("receiveDirective without a configured agentId refuses (cannot check addressee)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = new Agent({ callbackUrl: "https://a.example/r", callbackKey: KEY, sealKey: randomBytes(32) });
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });
  const [d] = hub.drainInbox(AGENT_A);
  const res = agent.receiveDirective(d!.directive, d!.signature, now.t);
  assert.equal(res.acted, false);
  assert.match(res.acted === false ? res.reason : "", /agentId.*not configured/);
});

test("drainInbox honors the `max` batch cap and leaves the remainder FIFO", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const a = hub.sendDirective({ from: "human:alice", to: TO_A, title: "first" });
  const b = hub.sendDirective({ from: "human:alice", to: TO_A, title: "second" });
  const c = hub.sendDirective({ from: "human:alice", to: TO_A, title: "third" });

  const first = hub.drainInbox(AGENT_A, { max: 2 });
  assert.deepEqual(first.map((d) => d.directive.id), [a.id, b.id], "first two, in order");
  // a,b are now in-flight (invisible); a second drain within the window returns only the 3rd.
  const rest = hub.drainInbox(AGENT_A, { max: 2 });
  assert.deepEqual(rest.map((d) => d.directive.id), [c.id], "the capped-off 3rd drains next, still FIFO");
});

test("drainInbox with a NaN `max` does NOT disable the cap (drains nothing, not everything)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "a" });
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "b" });
  // A NaN (e.g. from parsing `?max=abc`) must coerce to 0, never Infinity — the whole-mailbox drain
  // bug is `out.length >= NaN` being always false.
  const drained = hub.drainInbox(AGENT_A, { max: Number.NaN });
  assert.equal(drained.length, 0, "NaN max drains nothing rather than the whole mailbox");
});

test("tamper: a `from` (author) spoofed in transit fails signature verification (§9.7)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });
  const [d] = hub.drainInbox(AGENT_A);
  const spoofed = { ...d!.directive, from: "human:mallory" as const };
  const res = agent.receiveDirective(spoofed, d!.signature, now.t);
  assert.equal(res.acted, false);
  assert.equal(res.acted === false && res.reason, "signature: signature mismatch");
});

test("injection: a forbidden cross-type field added in transit is rejected despite a valid signature", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const agent = newAgent();
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "hold" });
  const [d] = hub.drainInbox(AGENT_A);
  // `state` is not in payload_sha256, so an on-path injector can append it without breaking the
  // signature. The agent MUST validate the shape (§13.1 forbids request/action/state) and refuse.
  const injected = { ...d!.directive, state: { exfil: "arbitrary" } };
  const res = agent.receiveDirective(injected, d!.signature, now.t);
  assert.equal(res.acted, false);
  assert.match(res.acted === false ? res.reason : "", /invalid directive/);
});

test("sendDirective rejects an expires_at that is not in the future (§13.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  assert.throws(
    () =>
      hub.sendDirective({
        from: "human:alice",
        to: TO_A,
        title: "stale",
        expires_at: new Date(T0 - 1_000).toISOString(),
      }),
    (e: unknown) => e instanceof HubError && e.code === "invalid_field",
  );
});

test("drainInbox returns a copy: mutating a delivery does not corrupt the durable mailbox record", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.sendDirective({ from: "human:alice", to: TO_A, title: "original" });
  const [d1] = hub.drainInbox(AGENT_A);
  (d1!.directive as { title: string }).title = "tampered by a buggy consumer";
  now.t += 61_000;
  const [d2] = hub.drainInbox(AGENT_A); // redelivery re-signs over the STORED record
  assert.equal(d2!.directive.title, "original", "the mailbox record is unaffected by a mutated delivery");
});

test("§9.7 digest binds content only: expires_at/sensitive are unbound (same payload_sha256)", () => {
  const base = {
    ma2h_version: "0.4" as const,
    type: "directive" as const,
    id: "dir_x",
    from: "human:alice" as const,
    to: TO_A,
    created_at: "2026-06-30T12:00:00Z",
    title: "hold",
    body: "hold all deploys",
  };
  const bare = computeDirectivePayloadSha256(base);
  const withMeta = computeDirectivePayloadSha256({
    ...base,
    expires_at: "2026-07-01T00:00:00Z",
    sensitive: true,
  });
  assert.equal(withMeta, bare, "expires_at/sensitive are Hub-authoritative metadata, not part of the bound content");
  // A bound content field (title) DOES change the digest.
  assert.notEqual(computeDirectivePayloadSha256({ ...base, title: "ship" }), bare);
});
