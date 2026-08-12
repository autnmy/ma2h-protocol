// §9.8 inter-agent entry signatures — pinned to the deterministic worked examples in
// examples/entry-signatures-v0.5.md (test key ma2h-test-secret-key-0123456789ab). These fixtures
// are the cross-implementation interop target: if a digest wrapper or context key drifts, these
// byte-exact reproductions fail before any behavioral test does.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize } from "../src/canonicalize.js";
import {
  buildMessageEntrySignedContext,
  buildReceiptSignedContext,
  buildResponseEntrySignedContext,
  computeMessageEntryPayloadSha256,
  computePayloadSha256,
  computeReceiptSha256,
  signMessageEntry,
  signReceipt,
  signResponseEntry,
  verifyMessageEntry,
  verifyReceipt,
  verifyResponseEntry,
} from "../src/signing.js";
import type { InterAgentMessage, ReceiptEntry, ResponseDetail } from "../src/types.js";

const KEY = "ma2h-test-secret-key-0123456789ab";
const EXAMPLES = new URL("../../examples/", import.meta.url);

const messageEntry = JSON.parse(
  readFileSync(new URL("message-inter-agent-ask.json", EXAMPLES), "utf8"),
) as InterAgentMessage;
const receiptEntry = JSON.parse(
  readFileSync(new URL("receipt-bounced.json", EXAMPLES), "utf8"),
) as ReceiptEntry;

// ---- 1. `message` entry (worked example §1) ----

test("message entry: payload digest + canonical context + v1 reproduce the worked example", () => {
  const digest = computeMessageEntryPayloadSha256(messageEntry);
  assert.equal(digest, "f5d7fe8d3c10f59cf353375d9dd078bf36c74cb7cf503ed76fcdb2de3ad719ee");
  const sc = buildMessageEntrySignedContext({
    from: messageEntry.from,
    id: messageEntry.id,
    jti: "jti_01J5MSGDEMOFIX",
    ma2h_version: messageEntry.ma2h_version,
    payload_sha256: digest,
    t: 1786752000,
    to: messageEntry.to,
  });
  const { canonical, v1, header } = signMessageEntry(sc, { key: KEY });
  assert.equal(
    canonical,
    '{"from":"agent:overseer/fleet#sess_01J5OVR0001","id":"msg_01J5MSG0002","jti":"jti_01J5MSGDEMOFIX","ma2h_version":"0.5","payload_sha256":"f5d7fe8d3c10f59cf353375d9dd078bf36c74cb7cf503ed76fcdb2de3ad719ee","t":"1786752000","to":"agent:deploybot/dev-team#sess_01J5WRK0007"}',
  );
  assert.equal(v1, "4ppFPmg1vtR0F4Fu0LWHWxKXCXyM-CUdMgkFF_xswPA");
  assert.equal(
    header,
    "MA2H-Signature: t=1786752000,jti=jti_01J5MSGDEMOFIX,v1=4ppFPmg1vtR0F4Fu0LWHWxKXCXyM-CUdMgkFF_xswPA",
  );
  // The verifier recomputes the digest from the entry it received and verifies inside the window.
  const res = verifyMessageEntry(sc, v1, { key: KEY, now: 1786752000 * 1000 + 5000 });
  assert.equal(res.ok, true);
});

test("message digest binds the instruction surface and excludes transport/Hub metadata", () => {
  // Excluded fields (id/from/to/created_at/agent/idempotency_key) do not move the digest…
  const relabeled: InterAgentMessage = {
    ...messageEntry,
    id: "msg_DIFFERENT",
    from: "agent:someone/else#sess_X",
    to: "agent:another/agent",
    created_at: "2001-01-01T00:00:00Z",
    agent: { id: "spoof", run_id: "run_x", runtime: "cli" },
    idempotency_key: "different-key",
  };
  assert.equal(computeMessageEntryPayloadSha256(relabeled), computeMessageEntryPayloadSha256(messageEntry));
  // …while tampering any bound content field (here `request`) diverges it, so verification fails.
  const tampered = structuredClone(messageEntry);
  if (tampered.type !== "ask") assert.fail("fixture is an ask");
  tampered.request.mode = "select";
  const digest = computeMessageEntryPayloadSha256(tampered);
  assert.notEqual(digest, computeMessageEntryPayloadSha256(messageEntry));
  const sc = buildMessageEntrySignedContext({
    from: tampered.from,
    id: tampered.id,
    jti: "jti_01J5MSGDEMOFIX",
    ma2h_version: tampered.ma2h_version,
    payload_sha256: digest,
    t: 1786752000,
    to: tampered.to,
  });
  const res = verifyMessageEntry(sc, "4ppFPmg1vtR0F4Fu0LWHWxKXCXyM-CUdMgkFF_xswPA", {
    key: KEY,
    now: 1786752000 * 1000 + 5000,
  });
  assert.equal(res.ok, false);
});

test("message digest binds `sensitive` (unlike the §9.7 directive digest)", () => {
  const flagged: InterAgentMessage = { ...structuredClone(messageEntry), sensitive: true };
  assert.notEqual(computeMessageEntryPayloadSha256(flagged), computeMessageEntryPayloadSha256(messageEntry));
});

// ---- 2. `response` entry (worked example §2) ----

const responseDetail: ResponseDetail = {
  actor: "agent:deploybot/dev-team#sess_01J5WRK0007",
  edited: false,
  resolved_at: "2026-08-10T12:05:00Z",
  value: "approve",
};
const responseState = { sealed: "v1.demo.MOCK-SEALED-STATE-BLOB" };

test("response entry: §9.2-identical payload digest + canonical context + v1 reproduce the worked example", () => {
  // The digest is the SAME code path §9.2 push verification uses — byte-for-byte.
  const digest = computePayloadSha256(responseDetail, responseState);
  assert.equal(digest, "21bf7d8c7b9245170bbe80d0256de0779fa2490a08cc96c3c4e02568a33f997f");
  const sc = buildResponseEntrySignedContext({
    id: "msg_01J5MSG0002",
    in_reply_to: "msg_01J5MSG0002",
    jti: "jti_01J5RSPDEMOFIX",
    ma2h_version: "0.5",
    payload_sha256: digest,
    resolution: "answered",
    resolution_id: "res_01J5RSLV0001",
    resolved_at: "2026-08-10T12:05:00Z",
    t: 1786752060,
    to: "agent:overseer/fleet#sess_01J5OVR0001",
  });
  const { canonical, v1 } = signResponseEntry(sc, { key: KEY });
  assert.equal(
    canonical,
    '{"id":"msg_01J5MSG0002","in_reply_to":"msg_01J5MSG0002","jti":"jti_01J5RSPDEMOFIX","ma2h_version":"0.5","payload_sha256":"21bf7d8c7b9245170bbe80d0256de0779fa2490a08cc96c3c4e02568a33f997f","resolution":"answered","resolution_id":"res_01J5RSLV0001","resolved_at":"2026-08-10T12:05:00Z","t":"1786752060","to":"agent:overseer/fleet#sess_01J5OVR0001"}',
  );
  assert.equal(v1, "ML7nxivSFOMqQ8CerEeBJmMV6919d9GZ5GbSd49n36c");
  assert.equal(verifyResponseEntry(sc, v1, { key: KEY, now: 1786752060 * 1000 + 5000 }).ok, true);
});

test("response entry: a context rebuilt for a different destination session fails verification", () => {
  // Cross-endpoint replay defense (§9.8): the verifier reconstructs `to` from its OWN drain
  // identity, so an entry signed for one session cannot verify replayed to another.
  const digest = computePayloadSha256(responseDetail, responseState);
  const signedForOther = buildResponseEntrySignedContext({
    id: "msg_01J5MSG0002",
    in_reply_to: "msg_01J5MSG0002",
    jti: "jti_01J5RSPDEMOFIX",
    ma2h_version: "0.5",
    payload_sha256: digest,
    resolution: "answered",
    resolution_id: "res_01J5RSLV0001",
    resolved_at: "2026-08-10T12:05:00Z",
    t: 1786752060,
    to: "agent:overseer/fleet#sess_SOMEOTHER",
  });
  const res = verifyResponseEntry(signedForOther, "ML7nxivSFOMqQ8CerEeBJmMV6919d9GZ5GbSd49n36c", {
    key: KEY,
    now: 1786752060 * 1000 + 5000,
  });
  assert.equal(res.ok, false);
});

test("response entry: resolved_at is JSON null when a task Response has no detail (§9.8)", () => {
  const digest = computePayloadSha256(undefined, undefined);
  const sc = buildResponseEntrySignedContext({
    id: "msg_X",
    in_reply_to: "msg_X",
    jti: "jti_X",
    ma2h_version: "0.5",
    payload_sha256: digest,
    resolution: "completed",
    resolution_id: "res_X",
    resolved_at: null,
    t: 1786752060,
    to: "agent:overseer/fleet#sess_01J5OVR0001",
  });
  const { canonical, v1 } = signResponseEntry(sc, { key: KEY });
  assert.ok(canonical.includes('"resolved_at":null'));
  // Round-trips: the verifier rebuilding the same null context verifies.
  assert.equal(verifyResponseEntry(sc, v1, { key: KEY, now: 1786752060 * 1000 }).ok, true);
});

// ---- 3. `receipt` entry (worked example §3) ----

test("receipt entry: fixed-key digest + canonical context + v1 reproduce the worked example", () => {
  const digest = computeReceiptSha256(receiptEntry);
  assert.equal(digest, "40abdcfbc1b8c32ed106288063609e5ef7a295f578afa1b17cde5d1c7405bcd6");
  const sc = buildReceiptSignedContext({
    in_reply_to: receiptEntry.in_reply_to,
    jti: "jti_01J5RCPDEMOFIX",
    ma2h_version: receiptEntry.ma2h_version,
    receipt_sha256: digest,
    t: 1786752120,
    to: receiptEntry.to,
  });
  const { canonical, v1, header } = signReceipt(sc, { key: KEY });
  assert.equal(
    canonical,
    '{"in_reply_to":"msg_01J5MSG0003","jti":"jti_01J5RCPDEMOFIX","ma2h_version":"0.5","receipt_sha256":"40abdcfbc1b8c32ed106288063609e5ef7a295f578afa1b17cde5d1c7405bcd6","t":"1786752120","to":"agent:overseer/fleet#sess_01J5OVR0001"}',
  );
  assert.equal(v1, "-80T4jjtirjLy6Fri6osKG_gPS-CQhfd9uXgV0_9l78");
  assert.equal(
    header,
    "MA2H-Signature: t=1786752120,jti=jti_01J5RCPDEMOFIX,v1=-80T4jjtirjLy6Fri6osKG_gPS-CQhfd9uXgV0_9l78",
  );
  assert.equal(verifyReceipt(sc, v1, { key: KEY, now: 1786752120 * 1000 + 5000 }).ok, true);
});

test("receipt digest serializes an absent optional as JSON null (fixed six-key wrapper)", () => {
  // Future minors may add events whose receipts omit members; the wrapper always carries all six
  // keys with null for absences, exactly as §14.4's ack_sha256 wrapper.
  const partial = { ...receiptEntry } as Record<string, unknown>;
  delete partial["prior"];
  const digest = computeReceiptSha256(partial as unknown as ReceiptEntry);
  const expected = canonicalize({
    at: receiptEntry.at,
    event: receiptEntry.event,
    id: receiptEntry.id,
    in_reply_to: receiptEntry.in_reply_to,
    prior: null,
    session: receiptEntry.session,
  });
  assert.equal(digest, createHash("sha256").update(expected).digest("hex"));
});

test("receipt: a tampered `prior` diverges the digest so verification fails", () => {
  const tampered: ReceiptEntry = { ...receiptEntry, prior: "delivered" };
  const digest = computeReceiptSha256(tampered);
  assert.notEqual(digest, computeReceiptSha256(receiptEntry));
  const sc = buildReceiptSignedContext({
    in_reply_to: tampered.in_reply_to,
    jti: "jti_01J5RCPDEMOFIX",
    ma2h_version: tampered.ma2h_version,
    receipt_sha256: digest,
    t: 1786752120,
    to: tampered.to,
  });
  const res = verifyReceipt(sc, "-80T4jjtirjLy6Fri6osKG_gPS-CQhfd9uXgV0_9l78", {
    key: KEY,
    now: 1786752120 * 1000 + 5000,
  });
  assert.equal(res.ok, false);
});
