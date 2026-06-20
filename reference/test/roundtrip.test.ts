// End-to-end: the exit -> human-resolve -> signed-push -> re-invoke -> verify ->
// open-state -> resume flow (spec §2.1), plus the lifecycle guarantees (§7) and
// at-most-once delivery (§6).

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hub, HubError, type DeliveredPush } from "../src/hub.js";
import { Agent, parseSignatureHeader } from "../src/agent.js";
import { buildSignedContext, computePayloadSha256, signResponse } from "../src/signing.js";
import { sealState } from "../src/state-seal.js";
import type { A2hMessage, JsonObject } from "../src/types.js";

const SIGNING_KEY = "hub-signing-key-0123456789abcdef0123456789abcdef";
const RESUME_URL = "https://deploybot.example/ahcp/resume";
const T0 = 1_750_000_000_000;

function makeAsk(sealKey: Buffer, t: number): A2hMessage {
  return {
    ahcp_version: "0.3",
    type: "ask",
    created_at: new Date(t).toISOString(),
    agent: { id: "deploybot/dev-team", run_id: "run_1", runtime: "github-actions" },
    title: "Ship the release to prod?",
    idempotency_key: "release-ship-1",
    expires_at: new Date(t + 60_000).toISOString(),
    state: { sealed: sealState({ resume_token: "node:promote-build", pr_branch: "feat/x" }, sealKey) },
    request: {
      mode: "select",
      options: [
        { value: "ship", label: "Ship" },
        { value: "hold", label: "Hold" },
      ],
      default_on_expire: "hold",
      allowed_resolvers: ["human:alice"],
      callback: { mode: "push", url: RESUME_URL, auth: { scheme: "hmac", secret_ref: "env:K" } },
    },
  };
}

test("ask round-trip: exit -> resolve -> signed push -> re-invoke -> verify -> resume", () => {
  const sealKey = randomBytes(32);
  const deliveries: DeliveredPush[] = [];
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0, onDeliver: (p) => { deliveries.push(p); } });
  const agent = new Agent({ callbackUrl: RESUME_URL, callbackKey: SIGNING_KEY, sealKey });

  const ack = hub.submit(makeAsk(sealKey, T0));
  assert.equal(ack.status, "open");

  // run #1 has exited; the human resolves
  const resp = hub.resolve(
    ack.id,
    { actor: "human:alice", resolution: "answered", value: "hold", comment: "wait for review" },
    T0 + 5_000,
  );
  assert.equal(resp.resolution, "answered");

  const d = deliveries[0];
  assert.ok(d, "a signed push was delivered");
  const r = agent.onResume(d.response, d.signature, T0 + 6_000);
  assert.equal(r.acted, true);
  if (r.acted) {
    assert.equal(r.resolution, "answered");
    assert.equal(r.value, "hold");
    assert.deepEqual(r.state, { resume_token: "node:promote-build", pr_branch: "feat/x" });
  }
});

test("duplicate delivery (push + pull) — the agent acts at most once", () => {
  const sealKey = randomBytes(32);
  const deliveries: DeliveredPush[] = [];
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0, onDeliver: (p) => { deliveries.push(p); } });
  const agent = new Agent({ callbackUrl: RESUME_URL, callbackKey: SIGNING_KEY, sealKey });

  const ack = hub.submit(makeAsk(sealKey, T0));
  hub.resolve(ack.id, { actor: "human:alice", resolution: "answered", value: "ship" }, T0 + 1_000);
  const d = deliveries[0];
  assert.ok(d);

  const first = agent.onResume(d.response, d.signature, T0 + 2_000);
  const second = agent.onResume(d.response, d.signature, T0 + 3_000);
  assert.equal(first.acted, true);
  assert.equal(second.acted, false);
  assert.match(second.acted === false ? second.reason : "", /duplicate/);
});

test("resolve after terminal returns the first outcome (first-terminal-wins)", () => {
  const sealKey = randomBytes(32);
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0 });
  const ack = hub.submit(makeAsk(sealKey, T0));
  const first = hub.resolve(ack.id, { actor: "human:alice", resolution: "answered", value: "ship" }, T0 + 1_000);
  const second = hub.resolve(ack.id, { actor: "human:alice", resolution: "declined" }, T0 + 2_000);
  assert.equal(second.resolution, "answered");
  assert.equal(second.resolution_id, first.resolution_id);
});

test("agent cancels its own open ask -> cancelled, Response delivered like a resolve (§8.4)", () => {
  const sealKey = randomBytes(32);
  const deliveries: DeliveredPush[] = [];
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0, onDeliver: (p) => { deliveries.push(p); } });
  const ack = hub.submit(makeAsk(sealKey, T0));

  const resp = hub.cancel(ack.id, "deploybot/dev-team", T0 + 1_000);
  assert.equal(resp.resolution, "cancelled");
  assert.equal(hub.get(ack.id, "deploybot/dev-team")?.status, "cancelled");
  assert.ok(deliveries[0], "the cancelled Response is delivered so the agent gets closure");

  // Idempotent: a repeat cancel returns the same terminal outcome.
  const again = hub.cancel(ack.id, "deploybot/dev-team", T0 + 2_000);
  assert.equal(again.resolution_id, resp.resolution_id);
});

test("submitter-binding (§9.1): a foreign principal cannot cancel or poll another agent's ask", () => {
  const sealKey = randomBytes(32);
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0 });
  const ack = hub.submit(makeAsk(sealKey, T0));

  // A different authenticated agent learns/guesses the id — it must not be able to withdraw it,
  // and the id must be indistinguishable from an unknown one (not_found, not a 403 that confirms it).
  assert.throws(
    () => hub.cancel(ack.id, "evilbot/other", T0 + 1_000),
    (e: unknown) => e instanceof HubError && e.code === "not_found",
  );
  // The same binding hides it from a foreign poll, but not from its submitter — and the ask
  // is untouched: still open, still the submitter's to resolve/cancel.
  assert.equal(hub.get(ack.id, "evilbot/other"), null);
  assert.equal(hub.get(ack.id, "deploybot/dev-team")?.status, "open");
});

test("cancel after a different terminal returns already_terminal carrying the existing outcome (§8.4 409)", () => {
  const sealKey = randomBytes(32);
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0 });
  const ack = hub.submit(makeAsk(sealKey, T0));
  hub.resolve(ack.id, { actor: "human:alice", resolution: "answered", value: "ship" }, T0 + 1_000);
  assert.throws(
    () => hub.cancel(ack.id, "deploybot/dev-team", T0 + 2_000),
    (e: unknown) =>
      e instanceof HubError &&
      e.code === "already_terminal" &&
      // §8.4: the 409 carries the existing { id, status, resolution } so the agent reads the
      // real outcome from the exception itself — no second lookup.
      e.details?.id === ack.id &&
      e.details?.status === "answered" &&
      e.details?.resolution === "answered",
  );
  assert.equal(hub.get(ack.id, "deploybot/dev-team")?.status, "answered");
});

test("a cancel past expires_at loses to the default expiry, not cancelled (§7 expiry-vs-cancel)", () => {
  const sealKey = randomBytes(32);
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0 });
  const ack = hub.submit(makeAsk(sealKey, T0)); // expires_at = T0 + 60_000, default_on_expire = "hold"
  // The submitter cancels one ms after the deadline but before any expiry sweep ran. The ask
  // expired at expires_at against the same clock, so the default outcome wins over cancel.
  const resp = hub.cancel(ack.id, "deploybot/dev-team", T0 + 60_001);
  assert.equal(resp.resolution, "expired");
  assert.equal(resp.defaulted, true);
  assert.equal(resp.response?.value, "hold");
  assert.equal(hub.get(ack.id, "deploybot/dev-team")?.status, "expired");
});

test("notify is delivered on acceptance and durably pull-checkable", () => {
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0 });
  const notify: A2hMessage = {
    ahcp_version: "0.3",
    type: "notify",
    created_at: new Date(T0).toISOString(),
    agent: { id: "deploybot/dev-team", run_id: "digest_1", runtime: "cloud" },
    title: "Daily digest",
    idempotency_key: "digest-1",
  };
  const ack = hub.submit(notify);
  assert.equal(ack.status, "delivered");
  const got = hub.get(ack.id, "deploybot/dev-team");
  assert.equal(got?.status, "delivered");
});

test("a human answer at expires_at wins; one millisecond later, default wins", () => {
  const sealKey = randomBytes(32);
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0 });

  const atDeadline = hub.resolve(
    hub.submit(makeAsk(sealKey, T0)).id,
    { actor: "human:alice", resolution: "answered", value: "ship" },
    T0 + 60_000,
  );
  assert.equal(atDeadline.resolution, "answered");
  assert.equal(atDeadline.response?.value, "ship");

  const afterDeadline = hub.resolve(
    hub.submit(makeAsk(sealKey, T0)).id,
    { actor: "human:alice", resolution: "answered", value: "ship" },
    T0 + 60_001,
  );
  assert.equal(afterDeadline.resolution, "expired");
  assert.equal(afterDeadline.defaulted, true);
  assert.equal(afterDeadline.response?.value, "hold");
  assert.equal(afterDeadline.response?.actor, "system:default_on_expire");
});

// Deterministically corrupt a ciphertext byte of a sealed-state blob (version.nonce.ct.tag).
function corruptSealed(state: JsonObject | undefined): string {
  const sealed = String(state!["sealed"]);
  const parts = sealed.split(".");
  const ctBuf = Buffer.from(parts[2]!, "base64url");
  ctBuf[0] = ctBuf[0]! ^ 0xff;
  return [parts[0], parts[1], ctBuf.toString("base64url"), parts[3]].join(".");
}

test("a tampered state blob in transit fails the signature (v0.3 binds the payload, issue #7)", () => {
  const sealKey = randomBytes(32);
  const deliveries: DeliveredPush[] = [];
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0, onDeliver: (p) => { deliveries.push(p); } });
  const agent = new Agent({ callbackUrl: RESUME_URL, callbackKey: SIGNING_KEY, sealKey });

  const ack = hub.submit(makeAsk(sealKey, T0));
  hub.resolve(ack.id, { actor: "human:alice", resolution: "answered", value: "hold" }, T0 + 1_000);
  const d = deliveries[0];
  assert.ok(d);

  // A proxy mutates the sealed state but cannot re-sign. The agent recomputes payload_sha256 over the
  // received (tampered) state; it diverges from the Hub's signed digest, so the SIGNATURE layer rejects
  // it before AEAD even runs. (In v0.2 this passed the signature and only AEAD caught it.)
  const tampered = { ...d.response, state: { sealed: corruptSealed(d.response.state) } };
  const r = agent.onResume(tampered, d.signature, T0 + 2_000);
  assert.equal(r.acted, false);
  assert.match(r.acted === false ? r.reason : "", /signature/);
});

test("AEAD seal still catches tampered state when the signature is valid (§9.3, malicious-Hub re-sign)", () => {
  const sealKey = randomBytes(32);
  const deliveries: DeliveredPush[] = [];
  const hub = new Hub({ signingKey: SIGNING_KEY, now: () => T0, onDeliver: (p) => { deliveries.push(p); } });
  const agent = new Agent({ callbackUrl: RESUME_URL, callbackKey: SIGNING_KEY, sealKey });

  const ack = hub.submit(makeAsk(sealKey, T0));
  hub.resolve(ack.id, { actor: "human:alice", resolution: "answered", value: "hold" }, T0 + 1_000);
  const d = deliveries[0];
  assert.ok(d);

  // Simulate a party that CAN sign (a malicious/compromised Hub) re-signing over the tampered payload:
  // the signature now verifies, but state integrity is the agent's own responsibility (§9.3) — the
  // per-agent AEAD seal key, which the Hub never sees, catches the corruption.
  const tampered = { ...d.response, state: { sealed: corruptSealed(d.response.state) } };
  const sig = parseSignatureHeader(d.signature);
  const reSigned = signResponse(
    buildSignedContext({
      ahcp_version: tampered.ahcp_version,
      callback_url: RESUME_URL,
      id: tampered.in_reply_to,
      in_reply_to: tampered.in_reply_to,
      jti: sig.jti,
      payload_sha256: computePayloadSha256(tampered.response, tampered.state),
      resolution: tampered.resolution,
      resolution_id: tampered.resolution_id,
      resolved_at: tampered.response?.resolved_at ?? "",
      t: sig.t,
    }),
    { key: SIGNING_KEY },
  ).header;

  const r = agent.onResume(tampered, reSigned, T0 + 2_000);
  assert.equal(r.acted, false);
  assert.match(r.acted === false ? r.reason : "", /integrity/);
});
