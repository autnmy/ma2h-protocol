// Conformance-vector runner — executes the vectors in ../conformance/vectors/.
// Only the executable classes run here: `schema-validation` (against the published
// schemas) and the `downstream-proof` signature fixtures (dp-001 payload-bound
// signature with recompute-from-payload, dp-003 payload-tamper rejection, dp-004
// numeric-payload canonicalization). `prose-audit` vectors are reported as skipped —
// human sign-off, not executable (spec §12).

import { readdirSync, readFileSync } from "node:fs";
import {
  validateAck,
  validateCapability,
  validateInboundMessage,
  validateMessage,
  validatePresence,
  validateResponse,
  validateV05,
  type ValidationResult,
} from "./envelope.js";
import {
  buildAckSignedContext,
  buildInboundSignedContext,
  buildMessageEntrySignedContext,
  buildReceiptSignedContext,
  buildResponseEntrySignedContext,
  buildSignedContext,
  computeAckSha256,
  computeDirectivePayloadSha256,
  computeMessageEntryPayloadSha256,
  computePayloadSha256,
  computeReceiptSha256,
  signAck,
  signInbound,
  signMessageEntry,
  signReceipt,
  signResponse,
  signResponseEntry,
  verifyAck,
  verifyInbound,
  verifyMessageEntry,
  verifyReceipt,
  verifyResponse,
  verifyResponseEntry,
} from "./signing.js";
import { canonicalize } from "./canonicalize.js";
import type {
  A2hResponse,
  Ack,
  AckSignedContext,
  AgentAddress,
  InboundDirective,
  InboundSignedContext,
  InterAgentMessage,
  JsonObject,
  MessageEntrySignedContext,
  ReceiptEntry,
  ReceiptSignedContext,
  ResponseDetail,
  ResponseEntrySignedContext,
  SignedContext,
} from "./types.js";

export type VectorStatus = "pass" | "fail" | "skip";
export interface VectorResult {
  id: string;
  cls: string;
  status: VectorStatus;
  detail?: string;
}
export interface VectorReport {
  results: VectorResult[];
  passed: number;
  failed: number;
  skipped: number;
}

const VECTORS_DIR = new URL("../../conformance/vectors/", import.meta.url);

function validateAgainst(target: string, data: unknown): ValidationResult {
  // v0.5-targeted vectors name their schema as "v0.5/<file>" (schema/v0.5/,
  // spec/v0.5.md); everything else keeps validating against the v0.4 snapshot.
  if (target.startsWith("v0.5/")) {
    return validateV05(target.slice("v0.5/".length), data);
  }
  switch (target) {
    case "message.schema.json":
      return validateMessage(data);
    case "response.schema.json":
      return validateResponse(data);
    case "capability.schema.json":
      return validateCapability(data);
    case "inbound-message.schema.json":
      return validateInboundMessage(data);
    case "ack.schema.json":
      return validateAck(data);
    case "presence.schema.json":
      return validatePresence(data);
    default:
      throw new Error(`vector target not runnable: ${target}`);
  }
}

function runOne(id: string, cls: string, v: Record<string, unknown>): VectorResult {
  if (cls === "schema-validation") {
    const target = String(v["target"]);
    const expect: "valid" | "invalid" = v["expect"] === "valid" ? "valid" : "invalid";
    const res = validateAgainst(target, v["input"]);
    const got: "valid" | "invalid" = res.valid ? "valid" : "invalid";
    if (got === expect) return { id, cls, status: "pass" };
    const why = res.valid ? "" : `: ${res.errors.join("; ")}`;
    return { id, cls, status: "fail", detail: `expected ${expect}, got ${got}${why}` };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-001")) {
    const sc = v["signed_context"] as SignedContext;
    const key = String(v["test_key"]);
    const { v1, canonical } = signResponse(buildSignedContext(sc), { key });
    let ok = v1 === v["v1"] && canonical === v["canonical_jcs"];
    let detail = "signature/canonical mismatch";
    // §9.2: the digest in signed_context MUST equal a recompute over the `payload`.
    const payload = v["payload"] as { response?: ResponseDetail; state?: JsonObject } | undefined;
    if (payload) {
      const recomputed = computePayloadSha256(payload.response, payload.state);
      if (recomputed !== sc.payload_sha256) {
        ok = false;
        detail = "payload_sha256 does not bind the payload (recompute mismatch)";
      }
    }
    return ok ? { id, cls, status: "pass" } : { id, cls, status: "fail", detail };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-003")) {
    // Tamper proof (issue #7): the agent recomputes payload_sha256 over the RECEIVED payload.
    // Positive control — the honest payload reproduces the signed digest and verifies ok — must
    // pass first, so a verifier that simply rejects everything can't vacuously "pass" the tamper
    // case. Negative — a flipped value diverges the digest, so verification MUST fail with a
    // signature mismatch (not an incidental window/key/jti rejection).
    const sc = v["signed_context"] as SignedContext;
    const key = String(v["test_key"]);
    const v1 = String(v["v1"]);
    const now = Number(sc.t) * 1000 + 5000;
    const honest = v["honest_payload"] as { response?: ResponseDetail; state?: JsonObject };
    const tampered = v["tampered_payload"] as { response?: ResponseDetail; state?: JsonObject };
    const honestSc = buildSignedContext({
      ...sc,
      payload_sha256: computePayloadSha256(honest.response, honest.state),
    });
    const honestRes = verifyResponse(honestSc, v1, { key, now });
    if (!honestRes.ok) {
      return { id, cls, status: "fail", detail: `honest control did not verify (${honestRes.reason}) — tamper proof inconclusive` };
    }
    const tamperedSc = buildSignedContext({
      ...sc,
      payload_sha256: computePayloadSha256(tampered.response, tampered.state),
    });
    const res = verifyResponse(tamperedSc, v1, { key, now });
    if (res.ok) return { id, cls, status: "fail", detail: "tampered payload verified ok — binding broken" };
    if (res.reason !== "signature mismatch") {
      return { id, cls, status: "fail", detail: `tampered payload rejected for the wrong reason: ${res.reason}` };
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-004")) {
    // Numeric-payload canonicalization (§9.2): the JCS of {response, state} — including numbers — must
    // reproduce the pinned bytes, and its SHA-256 the pinned digest. A non-JS signer whose number
    // formatting diverges from RFC 8785 §3.2.2.3 fails here, catching cross-impl interop breaks early.
    const payload = v["payload"] as { response?: ResponseDetail; state?: JsonObject };
    const jcs = canonicalize({ response: payload.response ?? null, state: payload.state ?? null });
    if (jcs !== v["payload_canonical_jcs"]) {
      return { id, cls, status: "fail", detail: "canonical JCS mismatch (RFC 8785 number formatting)" };
    }
    if (computePayloadSha256(payload.response, payload.state) !== v["payload_sha256"]) {
      return { id, cls, status: "fail", detail: "payload_sha256 mismatch" };
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-005")) {
    // Inbound directive signature (§9.7): mirror of dp-001 for the human->agent leg. Reproduce the
    // header `v1` from JCS(inbound_signed_context) + HMAC, and prove `payload_sha256` binds the directive
    // by recomputing it from `directive` (never trusting the transmitted digest).
    const sc = v["signed_context"] as InboundSignedContext;
    const key = String(v["test_key"]);
    const { v1, canonical } = signInbound(buildInboundSignedContext(sc), { key });
    let ok = v1 === v["v1"] && canonical === v["canonical_jcs"];
    let detail = "signature/canonical mismatch";
    const directive = v["directive"] as InboundDirective | undefined;
    if (directive) {
      const recomputed = computeDirectivePayloadSha256(directive);
      if (recomputed !== sc.payload_sha256) {
        ok = false;
        detail = "payload_sha256 does not bind the directive (recompute mismatch)";
      }
    }
    return ok ? { id, cls, status: "pass" } : { id, cls, status: "fail", detail };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-006")) {
    // Directive tamper proof (§9.7): the agent reconstructs inbound_signed_context from the directive it
    // RECEIVED (recomputing payload_sha256 and re-reading the bound from/id/to). Positive control — the
    // honest directive reproduces the signed context and verifies — must pass first. Negative — a
    // redirected `to` (or altered from/body) diverges the context, so verification MUST fail with a
    // signature mismatch, proving a directive signed for one agent can't be replayed into another's.
    const key = String(v["test_key"]);
    const v1 = String(v["v1"]);
    const jti = String(v["jti"]);
    const t = String(v["t"]);
    const now = Number(t) * 1000 + 5000;
    const scFrom = (d: InboundDirective): InboundSignedContext =>
      buildInboundSignedContext({
        from: d.from,
        id: d.id,
        jti,
        ma2h_version: d.ma2h_version,
        payload_sha256: computeDirectivePayloadSha256(d),
        t,
        to: d.to,
      });
    const honest = v["honest_directive"] as InboundDirective;
    const tampered = v["tampered_directive"] as InboundDirective;
    const honestRes = verifyInbound(scFrom(honest), v1, { key, now });
    if (!honestRes.ok) {
      return { id, cls, status: "fail", detail: `honest control did not verify (${honestRes.reason}) — tamper proof inconclusive` };
    }
    const res = verifyInbound(scFrom(tampered), v1, { key, now });
    if (res.ok) return { id, cls, status: "fail", detail: "tampered directive verified ok — binding broken" };
    if (res.reason !== "signature mismatch") {
      return { id, cls, status: "fail", detail: `tampered directive rejected for the wrong reason: ${res.reason}` };
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-008")) {
    // Pushed-ack signature (§14.4): mirror of dp-001/dp-005 for the receipt. Reproduce header `v1` from
    // JCS(ack_signed_context) + HMAC, and prove `ack_sha256` binds the ack by recomputing it from `ack`.
    const sc = v["signed_context"] as AckSignedContext;
    const key = String(v["test_key"]);
    const { v1, canonical } = signAck(buildAckSignedContext(sc), { key });
    let ok = v1 === v["v1"] && canonical === v["canonical_jcs"];
    let detail = "signature/canonical mismatch";
    const ack = v["ack"] as Ack | undefined;
    if (ack) {
      const recomputed = computeAckSha256(ack);
      if (recomputed !== sc.ack_sha256) {
        ok = false;
        detail = "ack_sha256 does not bind the ack (recompute mismatch)";
      }
    }
    return ok ? { id, cls, status: "pass" } : { id, cls, status: "fail", detail };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-009")) {
    // Pushed-ack tamper proof (§14.4): the human's client recomputes ack_sha256 from the received ack.
    // Honest control verifies; a tampered `note`/`by` diverges the digest → signature mismatch.
    const key = String(v["test_key"]);
    const v1 = String(v["v1"]);
    const jti = String(v["jti"]);
    const t = String(v["t"]);
    const now = Number(t) * 1000 + 5000;
    const scFrom = (a: Ack): AckSignedContext =>
      buildAckSignedContext({
        ack_sha256: computeAckSha256(a),
        by: a.by,
        in_reply_to: a.in_reply_to,
        jti,
        ma2h_version: a.ma2h_version,
        t,
      });
    const honest = v["honest_ack"] as Ack;
    const tampered = v["tampered_ack"] as Ack;
    const honestRes = verifyAck(scFrom(honest), v1, { key, now });
    if (!honestRes.ok) {
      return { id, cls, status: "fail", detail: `honest control did not verify (${honestRes.reason}) — tamper proof inconclusive` };
    }
    const res = verifyAck(scFrom(tampered), v1, { key, now });
    if (res.ok) return { id, cls, status: "fail", detail: "tampered ack verified ok — binding broken" };
    if (res.reason !== "signature mismatch") {
      return { id, cls, status: "fail", detail: `tampered ack rejected for the wrong reason: ${res.reason}` };
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-011")) {
    // §9.8 `message` entry signature: mirror of dp-001/dp-005 for the inter-agent leg. Reproduce
    // header `v1` from JCS(message_signed_context) + HMAC, and prove `payload_sha256` binds the
    // delivered entry's content fields by recomputing it from `entry`.
    const sc = v["signed_context"] as MessageEntrySignedContext;
    const key = String(v["test_key"]);
    const { v1, canonical } = signMessageEntry(buildMessageEntrySignedContext(sc), { key });
    let ok = v1 === v["v1"] && canonical === v["canonical_jcs"];
    let detail = "signature/canonical mismatch";
    const entry = v["entry"] as InterAgentMessage | undefined;
    if (entry && computeMessageEntryPayloadSha256(entry) !== sc.payload_sha256) {
      ok = false;
      detail = "payload_sha256 does not bind the entry content (recompute mismatch)";
    }
    return ok ? { id, cls, status: "pass" } : { id, cls, status: "fail", detail };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-012")) {
    // §9.8 message-entry tamper proof: honest control verifies, every tampered variant (redirected
    // `to`, flipped `from`, altered content) fails with a signature mismatch — mirror of dp-006.
    const key = String(v["test_key"]);
    const v1 = String(v["v1"]);
    const jti = String(v["jti"]);
    const t = String(v["t"]);
    const now = Number(t) * 1000 + 5000;
    const scFrom = (m: InterAgentMessage): MessageEntrySignedContext =>
      buildMessageEntrySignedContext({
        from: m.from,
        id: m.id,
        jti,
        ma2h_version: m.ma2h_version,
        payload_sha256: computeMessageEntryPayloadSha256(m),
        t,
        to: m.to,
      });
    const honest = v["honest_entry"] as InterAgentMessage;
    const honestRes = verifyMessageEntry(scFrom(honest), v1, { key, now });
    if (!honestRes.ok) {
      return { id, cls, status: "fail", detail: `honest control did not verify (${honestRes.reason}) — tamper proof inconclusive` };
    }
    const tampered = v["tampered_entries"] as Array<{ entry: InterAgentMessage; reason: string }>;
    for (const t2 of tampered) {
      const res = verifyMessageEntry(scFrom(t2.entry), v1, { key, now });
      if (res.ok) return { id, cls, status: "fail", detail: `tampered entry verified ok (${t2.reason}) — binding broken` };
      if (res.reason !== "signature mismatch") {
        return { id, cls, status: "fail", detail: `tampered entry rejected for the wrong reason: ${res.reason}` };
      }
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && (id.startsWith("dp-013") || id.startsWith("dp-015"))) {
    // §9.8 `response` entry signature (dp-015: the null-`resolved_at` reconstruction for a
    // detail-less task Response). The verifier reconstructs the context from exactly the delivered
    // body + its OWN drain identity: `to` from the per-case drain identity, `id` from
    // `in_reply_to`, the digest via the §9.2-identical computePayloadSha256.
    const sc = v["signed_context"] as ResponseEntrySignedContext;
    const key = String(v["test_key"]);
    const entry = v["entry"] as A2hResponse;
    const identity = v["drain_identity"] as { reconstructed_to: string };
    const reconstructed = buildResponseEntrySignedContext({
      id: entry.in_reply_to,
      in_reply_to: entry.in_reply_to,
      jti: sc.jti,
      ma2h_version: entry.ma2h_version,
      payload_sha256: computePayloadSha256(entry.response, entry.state),
      resolution: entry.resolution,
      resolution_id: entry.resolution_id,
      resolved_at: entry.response?.resolved_at ?? null,
      t: sc.t,
      to: identity.reconstructed_to as AgentAddress,
    });
    const { v1, canonical } = signResponseEntry(reconstructed, { key });
    if (canonicalize(reconstructed) !== canonicalize(sc)) {
      return { id, cls, status: "fail", detail: "reconstructed context diverges from the fixture signed_context" };
    }
    if (v1 !== v["v1"] || canonical !== v["canonical_jcs"]) {
      return { id, cls, status: "fail", detail: "signature/canonical mismatch" };
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-014")) {
    // §9.8 response-entry cross-session replay + tamper proof: the honest control verifies at the
    // honest drain identity; the SAME entry+header fails at any other session (the verifier's
    // reconstructed `to` diverges); tampered bodies fail at the honest identity.
    const key = String(v["test_key"]);
    const v1 = String(v["v1"]);
    const jti = String(v["jti"]);
    const t = String(v["t"]);
    const now = Number(t) * 1000 + 5000;
    const scFor = (entry: A2hResponse, to: string): ResponseEntrySignedContext =>
      buildResponseEntrySignedContext({
        id: entry.in_reply_to,
        in_reply_to: entry.in_reply_to,
        jti,
        ma2h_version: entry.ma2h_version,
        payload_sha256: computePayloadSha256(entry.response, entry.state),
        resolution: entry.resolution,
        resolution_id: entry.resolution_id,
        resolved_at: entry.response?.resolved_at ?? null,
        t,
        to: to as AgentAddress,
      });
    const honest = v["honest_entry"] as A2hResponse;
    const honestTo = (v["honest_drain_identity"] as { reconstructed_to: string }).reconstructed_to;
    const replayTo = (v["replay_drain_identity"] as { reconstructed_to: string }).reconstructed_to;
    const honestRes = verifyResponseEntry(scFor(honest, honestTo), v1, { key, now });
    if (!honestRes.ok) {
      return { id, cls, status: "fail", detail: `honest control did not verify (${honestRes.reason}) — proof inconclusive` };
    }
    const replayRes = verifyResponseEntry(scFor(honest, replayTo), v1, { key, now });
    if (replayRes.ok) return { id, cls, status: "fail", detail: "cross-session replay verified ok — destination binding broken" };
    if (!replayRes.ok && replayRes.reason !== "signature mismatch") {
      return { id, cls, status: "fail", detail: `replay rejected for the wrong reason: ${replayRes.reason}` };
    }
    const tampered = v["tampered_entries"] as Array<{ entry: A2hResponse; reason: string }>;
    for (const t2 of tampered) {
      const res = verifyResponseEntry(scFor(t2.entry, honestTo), v1, { key, now });
      if (res.ok) return { id, cls, status: "fail", detail: `tampered entry verified ok (${t2.reason}) — binding broken` };
      if (res.reason !== "signature mismatch") {
        return { id, cls, status: "fail", detail: `tampered entry rejected for the wrong reason: ${res.reason}` };
      }
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-016")) {
    // §9.8 `receipt` entry signature: reproduce `receipt_sha256` via the fixed six-key/null wrapper
    // from the received receipt, reconstruct `to` from the verifier's OWN drain identity (never the
    // wire body's `to`), and reproduce the header `v1`.
    const sc = v["signed_context"] as ReceiptSignedContext;
    const key = String(v["test_key"]);
    const entry = v["entry"] as ReceiptEntry;
    const identity = v["drain_identity"] as { reconstructed_to: string };
    const digest = computeReceiptSha256(entry);
    if (digest !== v["receipt_sha256"] || digest !== sc.receipt_sha256) {
      return { id, cls, status: "fail", detail: "receipt_sha256 does not bind the receipt (recompute mismatch)" };
    }
    const reconstructed = buildReceiptSignedContext({
      in_reply_to: entry.in_reply_to,
      jti: sc.jti,
      ma2h_version: entry.ma2h_version,
      receipt_sha256: digest,
      t: sc.t,
      to: identity.reconstructed_to as AgentAddress,
    });
    const { v1, canonical } = signReceipt(reconstructed, { key });
    if (v1 !== v["v1"] || canonical !== v["canonical_jcs"]) {
      return { id, cls, status: "fail", detail: "signature/canonical mismatch" };
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-017")) {
    // §9.8 receipt tamper + cross-destination replay proof: a flipped `prior` (the seen-ness lie)
    // and a rebound `in_reply_to` diverge the digest/context; the UNMODIFIED entry + header fail at
    // any other session because the verifier reconstructs `to` from its own drain identity.
    const key = String(v["test_key"]);
    const v1 = String(v["v1"]);
    const jti = String(v["jti"]);
    const t = String(v["t"]);
    const now = Number(t) * 1000 + 5000;
    const scFor = (entry: ReceiptEntry, to: string): ReceiptSignedContext =>
      buildReceiptSignedContext({
        in_reply_to: entry.in_reply_to,
        jti,
        ma2h_version: entry.ma2h_version,
        receipt_sha256: computeReceiptSha256(entry),
        t,
        to: to as AgentAddress,
      });
    const honest = v["honest_entry"] as ReceiptEntry;
    const honestTo = (v["honest_drain_identity"] as { reconstructed_to: string }).reconstructed_to;
    const replayTo = (v["replay_drain_identity"] as { reconstructed_to: string }).reconstructed_to;
    const honestRes = verifyReceipt(scFor(honest, honestTo), v1, { key, now });
    if (!honestRes.ok) {
      return { id, cls, status: "fail", detail: `honest control did not verify (${honestRes.reason}) — proof inconclusive` };
    }
    const replayRes = verifyReceipt(scFor(honest, replayTo), v1, { key, now });
    if (replayRes.ok) return { id, cls, status: "fail", detail: "cross-destination replay verified ok — destination binding broken" };
    if (!replayRes.ok && replayRes.reason !== "signature mismatch") {
      return { id, cls, status: "fail", detail: `replay rejected for the wrong reason: ${replayRes.reason}` };
    }
    const tampered = v["tampered_entries"] as Array<{ entry: ReceiptEntry; reason: string }>;
    for (const t2 of tampered) {
      const res = verifyReceipt(scFor(t2.entry, honestTo), v1, { key, now });
      if (res.ok) return { id, cls, status: "fail", detail: `tampered receipt verified ok (${t2.reason}) — binding broken` };
      if (res.reason !== "signature mismatch") {
        return { id, cls, status: "fail", detail: `tampered receipt rejected for the wrong reason: ${res.reason}` };
      }
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && id.startsWith("dp-018")) {
    // §9.8 per-delivery re-signing: the SAME entry delivered twice carries the same bound context
    // fields but a fresh t/jti each time — reproduce BOTH pinned signatures, and prove they differ
    // (a replayed earlier header is non-conformant Hub behavior).
    const key = String(v["test_key"]);
    const base = v["signed_context_base"] as Omit<MessageEntrySignedContext, "t" | "jti">;
    const deliveries = v["deliveries"] as Array<{ t: string; jti: string; canonical_jcs: string; v1: string }>;
    const seen: string[] = [];
    for (const d of deliveries) {
      const sc = buildMessageEntrySignedContext({ ...base, t: d.t, jti: d.jti });
      const { v1, canonical } = signMessageEntry(sc, { key });
      if (v1 !== d.v1 || canonical !== d.canonical_jcs) {
        return { id, cls, status: "fail", detail: `delivery (t=${d.t}) signature/canonical mismatch` };
      }
      seen.push(v1);
    }
    if (new Set(seen).size !== seen.length) {
      return { id, cls, status: "fail", detail: "re-signed deliveries produced identical signatures" };
    }
    return { id, cls, status: "pass" };
  }
  if (cls === "downstream-proof" && /^dp-(019|020|021|022|023|024)/.test(id)) {
    // Behavioral Hub obligations with no deterministic fixture (like dp-002/007/010): the generic
    // vector runner validates fixtures, not a live Hub. The reference DISCHARGES these in its
    // behavior suites — sessions (dp-019), interagent claims/stream/bounce/submit honesty
    // (dp-020/021/022/023), and the resolver rules (dp-024) — see reference/test/sessions.test.ts,
    // interagent.test.ts, and bridge.test.ts, which npm test runs alongside these vectors.
    return { id, cls, status: "skip", detail: "behavioral obligation — discharged by the reference behavior suites (sessions/interagent/bridge tests)" };
  }
  if (cls === "prose-audit") {
    return { id, cls, status: "skip", detail: "manual human sign-off (not executable)" };
  }
  return { id, cls, status: "skip", detail: "no executable check for this vector class" };
}

export function runVectors(dir: URL = VECTORS_DIR): VectorReport {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const results: VectorResult[] = [];
  for (const file of files) {
    const v = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, unknown>;
    const id = typeof v["id"] === "string" ? v["id"] : file;
    const cls = typeof v["class"] === "string" ? v["class"] : "unknown";
    results.push(runOne(id, cls, v));
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "pass") passed++;
    else if (r.status === "fail") failed++;
    else skipped++;
  }
  return { results, passed, failed, skipped };
}
