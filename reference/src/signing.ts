// MA2H detached Response signature — spec §9.2.
//
// The Hub signs a canonical `signed_context` (NOT the raw HTTP body) so the
// signature is bound to id + resolution_id + callback_url and cannot be replayed
// across messages/endpoints. The agent verifies before acting on a pushed Response.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./canonicalize.js";
import type {
  InboundDirective,
  InboundSignedContext,
  JsonObject,
  Resolution,
  ResponseDetail,
  SignedContext,
} from "./types.js";

export type SignatureAlg = "hmac-sha256" | "ed25519";

/** Fields bound by the signature, in spec order (canonicalize sorts them anyway). */
export const SIGNED_FIELDS = [
  "ma2h_version",
  "callback_url",
  "id",
  "in_reply_to",
  "jti",
  "payload_sha256",
  "resolution",
  "resolution_id",
  "resolved_at",
  "t",
] as const satisfies ReadonlyArray<keyof SignedContext>;

export interface SignedContextParts {
  ma2h_version: SignedContext["ma2h_version"];
  callback_url: string;
  id: string;
  in_reply_to: string;
  jti: string;
  /** Lowercase-hex SHA-256 of the canonical response payload (spec §9.2; see computePayloadSha256). */
  payload_sha256: string;
  resolution: Resolution;
  resolution_id: string;
  resolved_at: string;
  /** Textual unix seconds; coerced to string. */
  t: string | number;
}

/** Assemble the canonical signed_context from its parts. */
export function buildSignedContext(parts: SignedContextParts): SignedContext {
  return {
    ma2h_version: parts.ma2h_version,
    callback_url: parts.callback_url,
    id: parts.id,
    in_reply_to: parts.in_reply_to,
    jti: parts.jti,
    payload_sha256: parts.payload_sha256,
    resolution: parts.resolution,
    resolution_id: parts.resolution_id,
    resolved_at: parts.resolved_at,
    t: String(parts.t),
  };
}

/**
 * Digest of the agent-consumed Response payload, bound into the signature (spec §9.2, issue #7).
 *
 * Computed over a fixed-key wrapper `{ response, state }` (each `null` when absent) so the digest
 * is unambiguous and serialized with the same RFC 8785 JCS as the rest of the signed_context.
 * Binds the ENTIRE response detail (value, edited, actor, resolved_at, comment) and state blob —
 * no field cherry-picking — so a tampered answer fails verification.
 *
 * The Hub computes this over the payload it sends; the agent MUST RECOMPUTE it over the payload it
 * actually received (never trust a supplied digest) so a forged payload cannot carry a matching one.
 *
 * NOTE (§9.2): for payloads containing numbers, conformant signers/verifiers MUST agree on RFC 8785
 * number formatting. This reference canonicalize() is byte-exact for string/boolean/nested-string
 * payloads; production impls with numeric payloads SHOULD use a vetted JCS library.
 */
export function computePayloadSha256(response?: ResponseDetail, state?: JsonObject): string {
  const canonical = canonicalize({ response: response ?? null, state: state ?? null });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface SignResult {
  canonical: string;
  v1: string;
  header: string;
}

export interface SignOptions {
  alg?: SignatureAlg;
  key: string;
}

/**
 * Generic detached-signature core (spec §9.2 / §9.7). Both the Response `signed_context` and the inbound
 * `inbound_signed_context` are just canonical objects carrying `t` + `jti`; the sign/verify math is
 * identical, so both legs delegate here. The header format is the shared `MA2H-Signature`.
 */
function signCanonical(sc: { t: string; jti: string }, opts: SignOptions): SignResult {
  const alg = opts.alg ?? "hmac-sha256";
  if (alg !== "hmac-sha256") throw new Error(`alg not implemented in this slice: ${alg}`);
  if (!opts.key) throw new Error("signing key required");
  const canonical = canonicalize(sc);
  const v1 = createHmac("sha256", opts.key).update(canonical).digest("base64url");
  return { canonical, v1, header: `MA2H-Signature: t=${sc.t},jti=${sc.jti},v1=${v1}` };
}

export function signResponse(sc: SignedContext, opts: SignOptions): SignResult {
  return signCanonical(sc, opts);
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOptions {
  alg?: SignatureAlg;
  key: string;
  /** Agent's current time in ms (defaults to now). */
  now?: number;
  windowSeconds?: number;
}

function verifyCanonical(sc: { t: string }, v1: string, opts: VerifyOptions): VerifyResult {
  const alg = opts.alg ?? "hmac-sha256";
  if (alg !== "hmac-sha256") return { ok: false, reason: `alg not implemented: ${alg}` };
  if (!opts.key) return { ok: false, reason: "verify key required" };

  const now = opts.now ?? Date.now();
  const windowSeconds = opts.windowSeconds ?? 120;
  const t = Number(sc.t);
  if (!Number.isFinite(t)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(Math.floor(now / 1000) - t) > windowSeconds) {
    return { ok: false, reason: "outside replay window" };
  }

  const expected = createHmac("sha256", opts.key).update(canonicalize(sc)).digest();
  let got: Buffer;
  try {
    got = Buffer.from(v1, "base64url");
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  // NOTE: a conformant agent also rejects a replayed `jti` via a replay cache
  // (TTL >= windowSeconds). That belongs to the agent/Hub layer (see Agent).
  return { ok: true };
}

export function verifyResponse(sc: SignedContext, v1: string, opts: VerifyOptions): VerifyResult {
  return verifyCanonical(sc, v1, opts);
}

// ---- Inbound directive signature (spec §9.7) ----

/** Fields bound by the directive signature, in spec order (canonicalize sorts them anyway). */
export const SIGNED_INBOUND_FIELDS = [
  "from",
  "id",
  "jti",
  "ma2h_version",
  "payload_sha256",
  "t",
  "to",
] as const satisfies ReadonlyArray<keyof InboundSignedContext>;

export interface InboundSignedContextParts {
  from: InboundSignedContext["from"];
  id: string;
  jti: string;
  ma2h_version: InboundSignedContext["ma2h_version"];
  payload_sha256: string;
  t: string | number;
  to: InboundSignedContext["to"];
}

/** Assemble the canonical inbound_signed_context from its parts. */
export function buildInboundSignedContext(parts: InboundSignedContextParts): InboundSignedContext {
  return {
    from: parts.from,
    id: parts.id,
    jti: parts.jti,
    ma2h_version: parts.ma2h_version,
    payload_sha256: parts.payload_sha256,
    t: String(parts.t),
    to: parts.to,
  };
}

/**
 * Digest of the human-authored directive content, bound into the §9.7 signature.
 *
 * Computed over the fixed-key wrapper `{ directive: <content> }`, where `content` carries exactly the
 * directive's PRESENT `title`/`body`/`priority`/`tags`/`context` fields (Hub/transport metadata — `id`,
 * `from`, `to`, `created_at`, `expires_at`, `sensitive`, version — is excluded; `id`/`from`/`to` are bound
 * as top-level signed fields instead). Adding, stripping, or altering any content field diverges the JCS
 * bytes, so the agent — which RECOMPUTES this from the directive it received — rejects a tampered directive.
 */
export function computeDirectivePayloadSha256(directive: InboundDirective): string {
  // canonicalize() accepts `unknown` and validates JSON shape at runtime, so build the content
  // wrapper as a plain `Record<string, unknown>` and pass the fields (incl. the `Part[]` context)
  // directly — no `as unknown as` escape hatch on this security-relevant digest input.
  const content: Record<string, unknown> = { title: directive.title };
  if (directive.body !== undefined) content["body"] = directive.body;
  if (directive.priority !== undefined) content["priority"] = directive.priority;
  if (directive.tags !== undefined) content["tags"] = directive.tags;
  if (directive.context !== undefined) content["context"] = directive.context;
  const canonical = canonicalize({ directive: content });
  return createHash("sha256").update(canonical).digest("hex");
}

export function signInbound(sc: InboundSignedContext, opts: SignOptions): SignResult {
  return signCanonical(sc, opts);
}

export function verifyInbound(sc: InboundSignedContext, v1: string, opts: VerifyOptions): VerifyResult {
  return verifyCanonical(sc, v1, opts);
}
