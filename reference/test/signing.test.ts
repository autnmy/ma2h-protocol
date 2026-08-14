// Proves the §9.2 signature scheme against the conformance fixture dp-001.
// If this passes, the spec's signature mechanic is real, not just specified.
// Also proves the v0.3 payload binding (issue #7): the signature now covers a
// digest of the response payload, so a tampered value/actor/state fails verify.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSignedContext,
  computePayloadSha256,
  decodeMac,
  isWellFormedMac,
  signResponse,
  verifyResponse,
} from "../src/signing.js";
import { parseSignatureHeader } from "../src/agent.js";
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

// ---- Shared MAC decode/validate rule (issue #41; spec §9.2/§9.7/§9.8) ----

test("mac helpers — a fresh signResponse v1 (43 chars unpadded) is well-formed and decodes to 32 bytes", () => {
  const sc = buildSignedContext(vector.signed_context);
  const { v1 } = signResponse(sc, { key: vector.test_key });
  assert.equal(v1.length, 43);
  assert.equal(isWellFormedMac(v1), true);
  assert.equal(decodeMac(v1)?.length, 32);
});

test("mac helpers — structurally valid RFC 4648 padding (43+'=') decodes identically and still verifies", () => {
  const sc = buildSignedContext(vector.signed_context);
  const { v1 } = signResponse(sc, { key: vector.test_key });
  const padded = `${v1}=`;
  assert.equal(padded.length, 44);
  assert.equal(isWellFormedMac(padded), true);
  assert.deepEqual(decodeMac(padded), decodeMac(v1));
  // The verify path consumes the same rule, so the padded form of a genuine signature verifies.
  assert.deepEqual(verifyResponse(sc, padded, { key: vector.test_key, now: tMs + 5000 }), {
    ok: true,
  });
});

test("mac helpers — malformed padding is ill-formed (43+'==', and a stray '=' on a 44-char body)", () => {
  const { v1 } = signResponse(buildSignedContext(vector.signed_context), { key: vector.test_key });
  assert.equal(isWellFormedMac(`${v1}==`), false); // a 43-char value takes exactly one '='
  const body44 = "A".repeat(44); // remainder-0 body: unpadded form, takes no '='
  assert.equal(isWellFormedMac(body44), true);
  assert.equal(isWellFormedMac(`${body44}=`), false);
});

test("mac helpers — a 43-char hex-shaped MAC is well-formed (the oh-hai#711 regression case)", () => {
  const hexish = "0123456789abcdef0123456789abcdef0123456789a";
  assert.equal(hexish.length, 43);
  assert.match(hexish, /^[0-9a-f]+$/);
  assert.equal(isWellFormedMac(hexish), true);
  assert.equal(decodeMac(hexish)?.length, 32);
});

test("mac helpers — an 86-char (ed25519-sized) value is well-formed: 32 bytes is a floor, not exact", () => {
  const ed25519Sized = "B".repeat(86);
  assert.equal(isWellFormedMac(ed25519Sized), true);
  assert.equal(decodeMac(ed25519Sized)?.length, 64);
});

test("mac helpers — rejects the standard-base64 alphabet, foreign characters, internal '=', empty, and short values", () => {
  const rejects = [
    `+${"A".repeat(42)}`, // '+' — standard base64, deliberately tightened away
    `/${"A".repeat(42)}`, // '/' — standard base64, deliberately tightened away
    `${"A".repeat(21)} ${"A".repeat(21)}`, // whitespace Node's lenient decoder would skip
    `${"A".repeat(42)}!`, // character outside every base64 alphabet
    `${"A".repeat(21)}=${"A".repeat(21)}`, // internal '=' — padding is trailing-only
    "", // empty string
    "QUJDREVGRw", // 10 chars → 7 bytes, below the 32-byte floor
    "A".repeat(45), // remainder-1 body — invalid base64 regardless of padding
  ];
  for (const bad of rejects) {
    assert.equal(isWellFormedMac(bad), false, `expected ill-formed: ${JSON.stringify(bad)}`);
    assert.equal(decodeMac(bad), null);
  }
});

test("mac helpers — verify with a garbage v1 reports bad signature encoding", () => {
  const sc = buildSignedContext(vector.signed_context);
  const res = verifyResponse(sc, "not-base64url!!!", { key: vector.test_key, now: tMs + 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "bad signature encoding");
});

test("mac helpers — remainder-2 structural padding: an 86-char body takes exactly '==' (88 total), never a lone '='", () => {
  const body = "B".repeat(86); // 86 mod 4 = 2, so exact RFC 4648 padding is two '='s; decodes to 64 bytes
  const padded = `${body}==`;
  assert.equal(padded.length, 88);
  assert.equal(isWellFormedMac(padded), true);
  assert.deepEqual(decodeMac(padded), decodeMac(body), "padded and unpadded twins decode to identical bytes");
  assert.equal(decodeMac(padded)?.length, 64);
  // Partial padding on a remainder-2 body (87 chars) violates the exact-pad rule — ill-formed.
  assert.equal(isWellFormedMac(`${body}=`), false);
  assert.equal(decodeMac(`${body}=`), null);
});

test("mac helpers — parseSignatureHeader preserves v1 padding: a padded genuine header still verifies end to end", () => {
  const sc = buildSignedContext(vector.signed_context);
  const { v1, header } = signResponse(sc, { key: vector.test_key });
  // `v1` is the header's final part, so appending '=' pads exactly the v1 value on the wire.
  const parsed = parseSignatureHeader(`${header}=`);
  assert.equal(parsed.t, vector.signed_context.t);
  assert.equal(parsed.jti, vector.signed_context.jti);
  assert.equal(parsed.v1, `${v1}=`, "the parser slices after the FIRST '=' — trailing padding survives parsing");
  assert.deepEqual(verifyResponse(sc, parsed.v1, { key: vector.test_key, now: tMs + 5000 }), { ok: true });
});
