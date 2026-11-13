// Sender withdrawal (spec §8.4, v0.7 — SCP #83), proven BEHAVIOURALLY against the reference Hub:
// the submitting principal may withdraw an open `task` (it lands `dismissed` with the agent as
// `actor`), any cancel may carry a `comment` recorded as `response.comment`, and the §7 rules —
// first terminal wins, expiry beats a late cancel, `409 already_terminal`, idempotency — hold for a
// task exactly as for an ask. Discharges dp-030 and dp-031.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hub, HubError, type DeliveredPush, type HubOptions } from "../src/hub.js";
import { Agent } from "../src/agent.js";
import type { AskMessage, TaskMessage } from "../src/types.js";

const SIGNING_KEY = "hub-withdraw-key-0123456789abcdef0123456789abcd";
const RESUME_URL = "https://deploybot.example/ma2h/resume";
const T0 = 1_790_000_000_000;
const SENDER = "deploybot/dev-team";
const OTHER = "evilbot/other";
const WORKER = "worker/fleet";
const OWNER = "human:you";

function newHub(over: Partial<HubOptions> = {}): { hub: Hub; pushes: DeliveredPush[] } {
  const pushes: DeliveredPush[] = [];
  const hub = new Hub({
    signingKey: SIGNING_KEY,
    now: () => T0,
    onDeliver: (p) => {
      pushes.push(p);
    },
    ...over,
  });
  return { hub, pushes };
}

function task(over: Partial<TaskMessage> = {}): TaskMessage {
  return {
    ma2h_version: "0.7",
    type: "task",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_1", runtime: "cli" },
    title: "Rotate API_SIGNING_KEY",
    idempotency_key: "rotate-1",
    expires_at: new Date(T0 + 60_000).toISOString(),
    action: {
      instructions: "Rotate the key in the prod vault.",
      allowed_resolvers: ["human:alice"],
      callback: { mode: "push", url: RESUME_URL, auth: { scheme: "hmac", secret_ref: "env:K" } },
    },
    ...over,
  };
}

function ask(): AskMessage {
  return {
    ma2h_version: "0.7",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_1", runtime: "cli" },
    title: "Ship or hold?",
    idempotency_key: "ship-1",
    request: {
      mode: "select",
      options: [
        { value: "ship", label: "Ship" },
        { value: "hold", label: "Hold" },
      ],
      allowed_resolvers: ["human:alice"],
    },
  };
}

function isHubError(code: string, status?: number): (e: unknown) => boolean {
  return (e: unknown) => e instanceof HubError && e.code === code && (status === undefined || e.status === status);
}

test("dp-030: a foreign principal's withdraw is 404 and the task stays open; the submitter's lands dismissed", () => {
  const { hub } = newHub();
  const { id } = hub.submit(task());

  assert.throws(() => hub.cancel(id, OTHER, T0 + 1_000), isHubError("not_found", 404));
  assert.equal(hub.get(id, SENDER)?.status, "open", "a refused cross-principal withdraw changes nothing");

  const resp = hub.cancel(id, SENDER, T0 + 2_000);
  assert.equal(resp.resolution, "dismissed");
  assert.equal(hub.get(id, SENDER)?.status, "dismissed", "the §8.4 ack status for a task is `dismissed`");
});

test("a withdrawn task carries the agent actor and resolved_at, never a value (§6, §8.4)", () => {
  const { hub, pushes } = newHub();
  const { id } = hub.submit(task());
  const resp = hub.cancel(id, SENDER, T0 + 1_000);

  assert.equal(resp.response?.actor, `agent:${SENDER}`, "told apart from a human dismissal by the actor");
  assert.equal(resp.response?.resolved_at, new Date(T0 + 1_000).toISOString());
  assert.equal(resp.response?.value, undefined);
  assert.equal(resp.response?.comment, undefined, "no body means no comment");
  assert.equal(pushes.length, 1, "the terminal Response is delivered like a resolve");
});

test("dp-031: a cancel comment is recorded as response.comment and is inside the §9.2 signature", () => {
  const { hub, pushes } = newHub();
  const { id } = hub.submit(task());
  const comment = "Replaced by msg_01HNEXT: the vault moved.";
  const resp = hub.cancel(id, SENDER, T0 + 1_000, { comment });
  assert.equal(resp.response?.comment, comment);

  const push = pushes[0];
  assert.ok(push, "a signed push was delivered");
  const agent = new Agent({ callbackUrl: RESUME_URL, callbackKey: SIGNING_KEY, sealKey: randomBytes(32) });
  const honest = agent.onResume(push.response, push.signature, T0 + 1_500);
  assert.equal(honest.acted, true, "the honest Response verifies");

  const tampered = structuredClone(push.response);
  if (tampered.response) tampered.response.comment = "Do it anyway.";
  const verifier = new Agent({ callbackUrl: RESUME_URL, callbackKey: SIGNING_KEY, sealKey: randomBytes(32) });
  const forged = verifier.onResume(tampered, push.signature, T0 + 1_500);
  assert.equal(forged.acted, false, "an altered comment fails verification");
});

test("an ask cancel carries the comment too, and still resolves cancelled", () => {
  const { hub } = newHub();
  const { id } = hub.submit(ask());
  const resp = hub.cancel(id, SENDER, T0 + 1_000, { comment: "Answered elsewhere." });
  assert.equal(resp.resolution, "cancelled");
  assert.equal(resp.response?.actor, `agent:${SENDER}`);
  assert.equal(resp.response?.comment, "Answered elsewhere.");
});

test("no body and {} are both a plain withdrawal (§8.4)", () => {
  const { hub } = newHub();
  const a = hub.submit(task({ idempotency_key: "rotate-a" }));
  const b = hub.submit(task({ idempotency_key: "rotate-b" }));
  assert.equal(hub.cancel(a.id, SENDER, T0 + 1_000).response?.comment, undefined);
  assert.equal(hub.cancel(b.id, SENDER, T0 + 1_000, {}).response?.comment, undefined);
});

test("dp-031: an over-bound comment is refused 422 and the message stays open; at the bound it is accepted", () => {
  const { hub } = newHub({ maxCommentLength: 10 });
  const { id } = hub.submit(task());

  assert.throws(() => hub.cancel(id, SENDER, T0 + 1_000, { comment: "x".repeat(11) }), isHubError("invalid_field", 422));
  assert.equal(hub.get(id, SENDER)?.status, "open");

  // Counted in code points, so a comment of ten astral characters is at the bound, not over it.
  const resp = hub.cancel(id, SENDER, T0 + 2_000, { comment: "🔑".repeat(10) });
  assert.equal(resp.response?.comment, "🔑".repeat(10));
});

test("the cancel bound IS the resolve bound — one source, both §8.8 paths refuse over it", () => {
  const { hub } = newHub({ maxCommentLength: 10 });
  hub.setAgentOwner(SENDER, OWNER);
  hub.setAgentOwner(WORKER, OWNER);
  hub.setInterAgentEnabled(OWNER);
  const human = hub.submit(task());
  assert.throws(
    () => hub.resolve(human.id, { actor: "human:alice", resolution: "completed", comment: "x".repeat(11) }, T0 + 1_000),
    isHubError("invalid_field", 422),
  );
  assert.equal(hub.get(human.id, SENDER)?.status, "open");

  const addressed = hub.submit(task({ idempotency_key: "rotate-addr", to: `agent:${WORKER}`, action: { instructions: "rotate" } }));
  assert.throws(
    () => hub.resolveAsAgent(addressed.id, WORKER, { resolution: "completed", comment: "x".repeat(11) }, { now: T0 + 1_000 }),
    isHubError("invalid_field", 422),
  );
  assert.equal(hub.get(addressed.id, SENDER)?.status, "open");
});

test("a malformed cancel body is a 400 validation_error and changes nothing", () => {
  const { hub } = newHub();
  const { id } = hub.submit(task());
  // A transport hands the Hub parsed JSON; the Hub re-checks the shape rather than trusting the type.
  assert.throws(() => hub.cancel(id, SENDER, T0 + 1_000, JSON.parse('{"comment":42}')), isHubError("validation_error", 400));
  assert.equal(hub.get(id, SENDER)?.status, "open");
});

test("dp-031: a repeat cancel with a different comment returns the first Response unchanged", () => {
  const { hub, pushes } = newHub();
  const { id } = hub.submit(task());
  const first = hub.cancel(id, SENDER, T0 + 1_000, { comment: "first reason" });
  const again = hub.cancel(id, SENDER, T0 + 2_000, { comment: "second reason" });

  assert.equal(again.resolution_id, first.resolution_id);
  assert.equal(again.response?.comment, "first reason", "the first terminal is immutable");
  assert.equal(pushes.length, 1, "an idempotent repeat emits nothing new");
});

test("dp-030: a withdraw after completed is 409 already_terminal carrying the real outcome", () => {
  const { hub } = newHub();
  const { id } = hub.submit(task());
  hub.resolve(id, { actor: "human:alice", resolution: "completed" }, T0 + 1_000);

  assert.throws(
    () => hub.cancel(id, SENDER, T0 + 2_000),
    (e: unknown) =>
      isHubError("already_terminal", 409)(e) &&
      e instanceof HubError &&
      e.details?.id === id &&
      e.details?.status === "completed" &&
      e.details?.resolution === "completed",
  );
  assert.equal(hub.get(id, SENDER)?.status, "completed");
});

test("a human's dismissal is a different terminal from a withdrawal, so a later cancel is 409 too", () => {
  const { hub } = newHub();
  const { id } = hub.submit(task());
  hub.resolve(id, { actor: "human:alice", resolution: "dismissed" }, T0 + 1_000);

  assert.throws(
    () => hub.cancel(id, SENDER, T0 + 2_000),
    (e: unknown) => isHubError("already_terminal", 409)(e) && e instanceof HubError && e.details?.status === "dismissed",
  );
  assert.equal(hub.get(id, SENDER)?.response?.response?.actor, "human:alice", "the human's terminal stands");
});

test("a task the Hub auto-dismissed as system:undeliverable was not withdrawn, so a later cancel is 409", () => {
  const { hub } = newHub();
  hub.setAgentOwner(SENDER, OWNER);
  hub.setAgentOwner(WORKER, OWNER);
  hub.setInterAgentEnabled(OWNER);
  const workerSession = hub.registerSession(WORKER, undefined, T0).session;
  const { id } = hub.submit(task({ to: `agent:${WORKER}#${workerSession.id}`, action: { instructions: "rotate" } }));
  hub.closeSession(workerSession.id, OWNER, T0 + 1_000); // the operator kill-switch bounces the entry (§7, §16.4)
  assert.equal(hub.get(id, SENDER)?.response?.response?.actor, "system:undeliverable");

  assert.throws(
    () => hub.cancel(id, SENDER, T0 + 2_000),
    (e: unknown) => isHubError("already_terminal", 409)(e) && e instanceof HubError && e.details?.status === "dismissed",
  );
});

test("a withdraw strictly after expires_at loses to expiry: the task resolves expired (§7)", () => {
  const { hub } = newHub();
  const { id } = hub.submit(task()); // expires_at = T0 + 60_000
  const resp = hub.cancel(id, SENDER, T0 + 60_001, { comment: "too late" });
  assert.equal(resp.resolution, "expired");
  assert.equal(resp.response?.comment, undefined, "the late cancel's comment is not applied");
  assert.equal(hub.get(id, SENDER)?.status, "expired");
});

test("an addressed task withdrawn by its sender is no longer actionable: the addressee's resolve is 409", () => {
  const { hub } = newHub();
  hub.setAgentOwner(SENDER, OWNER);
  hub.setAgentOwner(WORKER, OWNER);
  hub.setInterAgentEnabled(OWNER);
  const { id } = hub.submit(task({ to: `agent:${WORKER}`, action: { instructions: "rotate" } }));

  hub.cancel(id, SENDER, T0 + 1_000, { comment: "Not needed any more." });
  assert.throws(
    () => hub.resolveAsAgent(id, WORKER, { resolution: "completed" }, { now: T0 + 2_000 }),
    isHubError("already_terminal", 409),
  );
});

test("notify is not withdrawable", () => {
  const { hub } = newHub();
  const { id } = hub.submit({
    ma2h_version: "0.7",
    type: "notify",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_1", runtime: "cli" },
    title: "Deploy finished",
  });
  assert.throws(() => hub.cancel(id, SENDER, T0 + 1_000), isHubError("validation_error", 400));
});
