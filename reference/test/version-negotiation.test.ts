// Reference Hub version negotiation (#9) — spec §10 major rejection + the v0.2→v0.3
// push-signature parity break (§9.2). Pull is unaffected (pull responses aren't
// signature-verified, §8.2), so a pre-0.3 pull message is accepted.

import test from "node:test";
import assert from "node:assert/strict";
import { Hub, HubError } from "../src/hub.js";
import type { A2hMessage, Callback } from "../src/types.js";

const SIGNING_KEY = "hub-signing-key-0123456789abcdef0123456789abcdef";
const T0 = 1_750_000_000_000;

const PUSH: Callback = {
  mode: "push",
  url: "https://agent.example/resume",
  auth: { scheme: "hmac", secret_ref: "env:K" },
};
const PULL: Callback = { mode: "pull" };

function newHub(): Hub {
  return new Hub({ signingKey: SIGNING_KEY, now: () => T0 });
}

/** A valid v0.3 ask, with `ahcp_version` overridden to exercise negotiation. */
function makeAsk(version: string, callback: Callback): A2hMessage {
  const base: A2hMessage = {
    ahcp_version: "0.3",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: "deploybot/dev-team", run_id: "run_1", runtime: "github-actions" },
    title: "Ship the release?",
    idempotency_key: "k1",
    request: {
      mode: "select",
      options: [
        { value: "ship", label: "Ship" },
        { value: "hold", label: "Hold" },
      ],
      allowed_resolvers: ["human:alice"],
      callback,
    },
  };
  return { ...base, ahcp_version: version as A2hMessage["ahcp_version"] };
}

const isCode = (code: string) => (e: unknown): boolean => e instanceof HubError && e.code === code;

test("§10: an unrecognized major is rejected with version_not_supported", () => {
  assert.throws(() => newHub().submit(makeAsk("1.0", PULL)), isCode("version_not_supported"));
});

test("pre-0.3 PUSH is rejected for signature parity (version_not_supported)", () => {
  // A v0.3 Hub signs the pushed Response with the payload-bound context (§9.2); a 0.2 agent
  // reconstructs the old 9-field context and rejects every callback — so reject at submit.
  assert.throws(() => newHub().submit(makeAsk("0.2", PUSH)), isCode("version_not_supported"));
});

test("pre-0.3 PULL is accepted — pull responses aren't signature-verified (§8.2)", () => {
  const ack = newHub().submit(makeAsk("0.2", PULL));
  assert.equal(ack.status, "open");
});

test("v0.3 PUSH is accepted (regression guard)", () => {
  const ack = newHub().submit(makeAsk("0.3", PUSH));
  assert.equal(ack.status, "open");
});

test("a malformed ahcp_version is a schema validation_error, not version_not_supported", () => {
  // Negotiation only fires on a parseable MAJOR.MINOR; anything else falls through to the schema.
  assert.throws(() => newHub().submit(makeAsk("x", PULL)), isCode("validation_error"));
});

test("a pre-0.3 ask missing `request` is a validation_error, not a TypeError (defensive callbackOf)", () => {
  // Negotiation runs before schema validation; the push-parity check reads the callback, so a
  // malformed ask/task lacking `request`/`action` must still yield a clean validation_error rather
  // than crash. (Regression for the pre-validation TypeError codex flagged.)
  const malformed = {
    ahcp_version: "0.2",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: "deploybot/dev-team", run_id: "run_1", runtime: "github-actions" },
    title: "Ship?",
    idempotency_key: "k1",
    // request intentionally omitted — schema-invalid
  } as unknown as A2hMessage;
  assert.throws(() => newHub().submit(malformed), isCode("validation_error"));
});

test("a non-object body (null) is a validation_error, not a TypeError (pre-validation guard)", () => {
  assert.throws(() => newHub().submit(null as unknown as A2hMessage), isCode("validation_error"));
});

test("a malformed dotted version (00.2) is a validation_error regardless of callback mode", () => {
  // The negotiation parse matches the schema's shape (^0\.\d+$ / canonical non-zero major), so a
  // malformed version falls through to schema validation consistently — the error code must NOT
  // depend on push vs pull (the inconsistency codex flagged).
  assert.throws(() => newHub().submit(makeAsk("00.2", PUSH)), isCode("validation_error"));
  assert.throws(() => newHub().submit(makeAsk("00.2", PULL)), isCode("validation_error"));
});
