// Conformance-vector runner — executes the vectors in ../conformance/vectors/.
// Only the executable classes run here: `schema-validation` (against the published
// schemas) and the `downstream-proof` signature fixtures (dp-001 payload-bound
// signature with recompute-from-payload, dp-003 payload-tamper rejection, dp-004
// numeric-payload canonicalization). `prose-audit` vectors are reported as skipped —
// human sign-off, not executable (spec §12).

import { readdirSync, readFileSync } from "node:fs";
import {
  validateCapability,
  validateInboundMessage,
  validateMessage,
  validateResponse,
  type ValidationResult,
} from "./envelope.js";
import {
  buildInboundSignedContext,
  buildSignedContext,
  computeDirectivePayloadSha256,
  computePayloadSha256,
  signInbound,
  signResponse,
  verifyInbound,
  verifyResponse,
} from "./signing.js";
import { canonicalize } from "./canonicalize.js";
import type {
  InboundDirective,
  InboundSignedContext,
  JsonObject,
  ResponseDetail,
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
  switch (target) {
    case "message.schema.json":
      return validateMessage(data);
    case "response.schema.json":
      return validateResponse(data);
    case "capability.schema.json":
      return validateCapability(data);
    case "inbound-message.schema.json":
      return validateInboundMessage(data);
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
