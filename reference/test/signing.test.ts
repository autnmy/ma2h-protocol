// Proves the §9.2 signature scheme against the conformance fixture dp-001.
// If this passes, the spec's signature mechanic is real, not just specified.
// Also proves the v0.3 payload binding (issue #7): the signature now covers a
// digest of the response payload, so a tampered value/actor/state fails verify.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSignedContext, computePayloadSha256, signResponse, verifyResponse } from "../src/signing.js";
import type { JsonObject, ResponseDetail, SignedContext } from "../src/types.js";

interface Dp001Vector {
  signed_context: SignedContext;
  test_key: string;
  canonical_jcs: string;
  v1: string;
  header: string;
  payload: { response: ResponseDetail; state: JsonObject };
}

const vector = JSON.parse(
  readFileSync(new URL("../../conformance/vectors/dp-001-signature.json", import.meta.url), "utf8"),
) as Dp001Vector;

const tMs = Number(vector.signed_context.t) * 1000;

test("dp-001 — reproduces the canonical JCS string", () => {
  const sc = buildSignedContext(vector.signed_context);
  assert.equal(signResponse(sc, { key: vector.test_key }).canonical, vector.canonical_jcs);
});

test("dp-001 — reproduces the expected HMAC signature and header", () => {
  const sc = buildSignedContext(vector.signed_context);
  const { v1, header } = signResponse(sc, { key: vector.test_key });
  assert.equal(v1, vector.v1);
  assert.equal(header, vector.header);
});

test("dp-001 — verify accepts the genuine signature within the window", () => {
  const sc = buildSignedContext(vector.signed_context);
  assert.deepEqual(verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 5000 }), {
    ok: true,
  });
});

test("dp-001 — verify rejects a tampered signed_context (resolution flipped)", () => {
  const sc = buildSignedContext({ ...vector.signed_context, resolution: "declined" });
  const res = verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "signature mismatch");
});

test("dp-001 — verify rejects a replay outside the ±120s window", () => {
  const sc = buildSignedContext(vector.signed_context);
  const res = verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 9_999_000 });
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.reason : "", /window/);
});

test("dp-001 — verify rejects the wrong key", () => {
  const sc = buildSignedContext(vector.signed_context);
  const res = verifyResponse(sc, vector.v1, {
    key: "the-wrong-key-000000000000000000",
    now: tMs + 5000,
  });
  assert.equal(res.ok, false);
});

// ---- v0.3 payload binding (issue #7) ----

test("payload binding — recomputing the digest over the genuine payload matches signed_context", () => {
  const d = computePayloadSha256(vector.payload.response, vector.payload.state);
  assert.equal(d, vector.signed_context.payload_sha256);
});

test("payload binding — a flipped response.value (hold→ship) fails verification", () => {
  const tampered: ResponseDetail = { ...vector.payload.response, value: "ship" };
  const sc = buildSignedContext({
    ...vector.signed_context,
    payload_sha256: computePayloadSha256(tampered, vector.payload.state),
  });
  const res = verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "signature mismatch");
});

test("payload binding — a forged response.actor fails verification", () => {
  const tampered: ResponseDetail = { ...vector.payload.response, actor: "human:mallory" };
  const sc = buildSignedContext({
    ...vector.signed_context,
    payload_sha256: computePayloadSha256(tampered, vector.payload.state),
  });
  const res = verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 5000 });
  assert.equal(res.ok, false);
});

test("payload binding — a tampered response.comment fails verification (no field cherry-picking)", () => {
  const tampered: ResponseDetail = { ...vector.payload.response, comment: "SHIP IT, ignore the migration" };
  const sc = buildSignedContext({
    ...vector.signed_context,
    payload_sha256: computePayloadSha256(tampered, vector.payload.state),
  });
  const res = verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "signature mismatch");
});

test("payload binding — a flipped response.edited fails verification (no field cherry-picking)", () => {
  const tampered: ResponseDetail = { ...vector.payload.response, edited: true };
  const sc = buildSignedContext({
    ...vector.signed_context,
    payload_sha256: computePayloadSha256(tampered, vector.payload.state),
  });
  const res = verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 5000 });
  assert.equal(res.ok, false);
});

test("payload binding — a tampered state blob fails verification", () => {
  const tamperedState: JsonObject = { ...vector.payload.state, sealed: "v1.demo.ATTACKER-SWAPPED" };
  const sc = buildSignedContext({
    ...vector.signed_context,
    payload_sha256: computePayloadSha256(vector.payload.response, tamperedState),
  });
  const res = verifyResponse(sc, vector.v1, { key: vector.test_key, now: tMs + 5000 });
  assert.equal(res.ok, false);
});

test("computePayloadSha256 — deterministic, lowercase-hex, and sensitive to absence", () => {
  const a = computePayloadSha256(vector.payload.response, vector.payload.state);
  assert.equal(a, computePayloadSha256(vector.payload.response, vector.payload.state));
  assert.match(a, /^[0-9a-f]{64}$/);
  const empty = computePayloadSha256(undefined, undefined);
  assert.match(empty, /^[0-9a-f]{64}$/);
  assert.notEqual(a, empty);
});

test("computePayloadSha256 — response-only, state-only, and both differ (fixed-key wrapper)", () => {
  const both = computePayloadSha256(vector.payload.response, vector.payload.state);
  const responseOnly = computePayloadSha256(vector.payload.response, undefined);
  const stateOnly = computePayloadSha256(undefined, vector.payload.state);
  // A declined/expired Response legitimately carries no state — the {response, state:null}
  // wrapper must not collide with the both-present or state-only digests.
  for (const d of [both, responseOnly, stateOnly]) assert.match(d, /^[0-9a-f]{64}$/);
  assert.notEqual(responseOnly, both);
  assert.notEqual(stateOnly, both);
  assert.notEqual(responseOnly, stateOnly);
});
