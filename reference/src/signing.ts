// MA2H detached Response signature — spec §9.2.
//
// The Hub signs a canonical `signed_context` (NOT the raw HTTP body) so the
// signature is bound to id + resolution_id + callback_url and cannot be replayed
// across messages/endpoints. The agent verifies before acting on a pushed Response.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./canonicalize.js";
import type {
  Ack,
  AckSignedContext,
  InboundDirective,
  InboundSignedContext,
  InterAgentMessage,
  JsonObject,
  MessageEntrySignedContext,
  ReceiptEntry,
  ReceiptSignedContext,
  Resolution,
  ResponseDetail,
  ResponseEntrySignedContext,
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

// ---- Shared MAC decode/validate rule (spec §9.2 / §9.7 / §9.8) ----

/**
 * Decode a wire `v1` MAC value (`MA2H-Signature: …,v1=<base64url(signature)>` — spec §9.2, mirrored
 * by the §9.7 directive signature and the §9.8 entry signatures) to its raw bytes, or `null` when
 * ill-formed.
 *
 * This is THE well-formedness rule for `v1`, exported beside the signer that emits it. A wire rule
 * with two implementations drifts: downstream hand-rolled a second validator with a hex regex and
 * rejected 100% of conformant traffic (oh-hai#711). Consumers import this rule instead of
 * re-deriving it.
 *
 * Screening is exactly: base64url alphabet (`[A-Za-z0-9_-]`), optional RFC 4648 padding accepted
 * only when structurally valid (pad count exactly `(4 − unpadded_length mod 4) mod 4`, so the
 * padded total length ≡ 0 mod 4 — a 43-char value takes exactly one `=`, a 44-char value takes
 * none), decoded length ≥ 32 bytes (a floor, not an exact match: HMAC-SHA256 is exactly 32,
 * ed25519 is 64). It deliberately stops there — no canonical round-trip enforcement, so a 43-char
 * hex-looking MAC is valid (the oh-hai#711 regression case; an earlier stricter downstream draft
 * rejected legitimately valid MACs). One deliberate tightening rides along: standard-base64
 * alphabet values (`+`/`/`) that Node's lenient `Buffer.from(v1, "base64url")` previously accepted
 * now reject — conformant §9.2 emitters are unaffected.
 *
 * The rule imposes a floor, not a ceiling, by design; callers using this as an ingest screen
 * should length-bound `v1` upstream at their transport layer (header/envelope size caps, §8.6).
 */
export function decodeMac(v1: string): Buffer | null {
  // Split trailing padding from the body; what remains must be pure base64url alphabet
  // (this also rejects the empty string and any internal `=`).
  let padLen = 0;
  while (padLen < v1.length && v1.charCodeAt(v1.length - 1 - padLen) === 0x3d /* '=' */) padLen++;
  const body = v1.slice(0, v1.length - padLen);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  const rem = body.length % 4;
  // A remainder-1 body is invalid base64 regardless of padding (RFC 4648 §4): the exact-pad rule
  // would demand (4 − 1) mod 4 = 3 pad chars, which no valid encoding carries.
  if (rem === 1) return null;
  const requiredPad = (4 - rem) % 4;
  if (padLen !== 0 && padLen !== requiredPad) return null;
  const bytes = Buffer.from(body, "base64url");
  return bytes.length >= 32 ? bytes : null;
}

/**
 * True when `v1` is a well-formed wire MAC per the shared rule above (spec §9.2/§9.7/§9.8).
 * Well-formed means decodable — NOT verified; verification is the timing-safe comparison
 * `verifyCanonical` performs against the recomputed digest.
 */
export function isWellFormedMac(v1: string): boolean {
  return decodeMac(v1) !== null;
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
  const got = decodeMac(v1);
  if (got === null) return { ok: false, reason: "bad signature encoding" };
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
 * The CONTENT fields the §9.7 directive digest binds (issue #45, R10) — THE one definition of the
 * directive's signed instruction surface. `computeDirectivePayloadSha256` iterates exactly this
 * list (present fields only), so an implementation that vendors the list and one that calls the
 * function cannot disagree about what the digest covers. Everything absent from this list —
 * `id`/`from`/`to` (bound as top-level signed-context fields instead), `created_at`, `expires_at`,
 * `sensitive`, `ma2h_version` — is transport/Hub metadata the §9.7 payload digest deliberately
 * excludes. NOT the sanitize keep-list: the keep-list (wire.ts) also carries delivered-but-unsigned
 * advisory fields, and is not derivable from this list.
 */
export const DIRECTIVE_CONTENT_FIELDS = [
  "title",
  "body",
  "priority",
  "tags",
  "context",
] as const satisfies ReadonlyArray<keyof InboundDirective & string>;

/**
 * Copy `fields` present on `source` into a plain content wrapper for canonicalization.
 * canonicalize() accepts `unknown` and validates JSON shape at runtime, so the wrapper is built as
 * a `Record<string, unknown>` with the fields passed directly (incl. `Part[]` context) — no
 * `as unknown as` escape hatch on this security-relevant digest input. RFC 8785 JCS sorts keys, so
 * list order never moves the bytes; only the field SET does.
 */
function presentContentFields<T extends object>(
  source: T,
  fields: ReadonlyArray<keyof T & string>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) content[field] = value;
  }
  return content;
}

/**
 * Digest of the human-authored directive content, bound into the §9.7 signature.
 *
 * Computed over the fixed-key wrapper `{ directive: <content> }`, where `content` carries exactly the
 * directive's PRESENT `DIRECTIVE_CONTENT_FIELDS` (`title`/`body`/`priority`/`tags`/`context`;
 * Hub/transport metadata — `id`, `from`, `to`, `created_at`, `expires_at`, `sensitive`, version — is
 * excluded; `id`/`from`/`to` are bound as top-level signed fields instead). Adding, stripping, or
 * altering any content field diverges the JCS bytes, so the agent — which RECOMPUTES this from the
 * directive it received — rejects a tampered directive.
 */
export function computeDirectivePayloadSha256(directive: InboundDirective): string {
  const content = presentContentFields(directive, DIRECTIVE_CONTENT_FIELDS);
  const canonical = canonicalize({ directive: content });
  return createHash("sha256").update(canonical).digest("hex");
}

export function signInbound(sc: InboundSignedContext, opts: SignOptions): SignResult {
  return signCanonical(sc, opts);
}

export function verifyInbound(sc: InboundSignedContext, v1: string, opts: VerifyOptions): VerifyResult {
  return verifyCanonical(sc, v1, opts);
}

// ---- Pushed-ack signature (spec §14.4) ----

export interface AckSignedContextParts {
  ack_sha256: string;
  by: Ack["by"];
  in_reply_to: string;
  jti: string;
  ma2h_version: AckSignedContext["ma2h_version"];
  t: string | number;
}

/** Assemble the canonical ack_signed_context from its parts. */
export function buildAckSignedContext(parts: AckSignedContextParts): AckSignedContext {
  return {
    ack_sha256: parts.ack_sha256,
    by: parts.by,
    in_reply_to: parts.in_reply_to,
    jti: parts.jti,
    ma2h_version: parts.ma2h_version,
    t: String(parts.t),
  };
}

/**
 * Digest of the ack payload the human consumes, bound into the §14.4 signature. Computed over the
 * fixed-key wrapper `{ acked_at, by, in_reply_to, note, resolution_id }` (each `null` when absent) so a
 * tampered `note`/`by` on a pushed ack fails verification. The verifier RECOMPUTES it from the received ack.
 */
export function computeAckSha256(ack: Ack): string {
  const canonical = canonicalize({
    acked_at: ack.acked_at,
    by: ack.by,
    in_reply_to: ack.in_reply_to,
    note: ack.note ?? null,
    resolution_id: ack.resolution_id ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Sign a pushed ack (§14.4). Pulled acks are transport-trusted and unsigned. */
export function signAck(sc: AckSignedContext, opts: SignOptions): SignResult {
  return signCanonical(sc, opts);
}

export function verifyAck(sc: AckSignedContext, v1: string, opts: VerifyOptions): VerifyResult {
  return verifyCanonical(sc, v1, opts);
}

// ---- v0.5 inter-agent entry signatures (spec §9.8) ----

/** Fields bound by the `message` entry signature, in spec order (the §9.7 mirror, same key set). */
export const SIGNED_MESSAGE_ENTRY_FIELDS = [
  "from",
  "id",
  "jti",
  "ma2h_version",
  "payload_sha256",
  "t",
  "to",
] as const satisfies ReadonlyArray<keyof MessageEntrySignedContext>;

export interface MessageEntrySignedContextParts {
  from: MessageEntrySignedContext["from"];
  id: string;
  jti: string;
  ma2h_version: MessageEntrySignedContext["ma2h_version"];
  payload_sha256: string;
  t: string | number;
  to: MessageEntrySignedContext["to"];
}

/** Assemble the canonical message_signed_context from its parts (spec §9.8). */
export function buildMessageEntrySignedContext(parts: MessageEntrySignedContextParts): MessageEntrySignedContext {
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
 * The per-kind CONTENT fields the §9.8 `message` entry digest binds (issue #45, R10) — THE one
 * definition of each kind's signed instruction surface. `computeMessageEntryPayloadSha256`
 * iterates exactly the delivered kind's row (present fields only), so a vendoring implementation
 * and this function cannot disagree about what the digest covers. `type` is bound on every row
 * (flipping notify/ask/task changes what the recipient does); `request` binds only for ask and
 * `action` only for task; `sensitive` is bound on this leg (unlike §9.7's directive digest)
 * because the RECIPIENT acts on the marker (§9.6). Transport/Hub metadata (`id`, `from`, `to`,
 * `created_at`, `expires_at`) is excluded — `from`/`id`/`to` are bound as top-level signed fields
 * instead — and the advisory `agent` descriptor and inert `idempotency_key` are excluded exactly
 * as §9.2 leaves the Response's top-level `agent` unbound. NOT the sanitize keep-lists: those
 * (wire.ts) also carry the delivered-but-unsigned advisory fields and are not derivable from here.
 */
export const MESSAGE_ENTRY_CONTENT_FIELDS = {
  notify: ["type", "title", "body", "priority", "tags", "context", "sensitive"],
  ask: ["type", "title", "body", "priority", "tags", "context", "request", "sensitive"],
  task: ["type", "title", "body", "priority", "tags", "context", "action", "sensitive"],
} as const satisfies {
  notify: ReadonlyArray<keyof Extract<InterAgentMessage, { type: "notify" }> & string>;
  ask: ReadonlyArray<keyof Extract<InterAgentMessage, { type: "ask" }> & string>;
  task: ReadonlyArray<keyof Extract<InterAgentMessage, { type: "task" }> & string>;
};

/**
 * Digest of the agent-authored message content, bound into the §9.8 `message` entry signature.
 *
 * Computed over the fixed-key wrapper `{ message: <content> }`, where `content` carries exactly the
 * delivered kind's PRESENT `MESSAGE_ENTRY_CONTENT_FIELDS` (among `type`/`title`/`body`/`priority`/
 * `tags`/`context`/`request`/`action`/`sensitive`) — the instruction surface the addressee
 * consumes. `type` is bound
 * because flipping notify/ask/task changes what the recipient does; `sensitive` is bound (unlike
 * §9.7's directive digest) because on this leg the RECIPIENT acts on the marker (§9.6 handling).
 * Transport/Hub metadata (`id`, `from`, `to`, `created_at`, `expires_at`) is excluded —
 * `from`/`id`/`to` are bound as top-level signed fields instead — and the advisory `agent`
 * descriptor and inert `idempotency_key` are excluded exactly as §9.2 leaves the Response's
 * top-level `agent` unbound. The verifier RECOMPUTES this from the entry it received.
 */
export function computeMessageEntryPayloadSha256(message: InterAgentMessage): string {
  const content =
    message.type === "ask"
      ? presentContentFields(message, MESSAGE_ENTRY_CONTENT_FIELDS.ask)
      : message.type === "task"
        ? presentContentFields(message, MESSAGE_ENTRY_CONTENT_FIELDS.task)
        : presentContentFields(message, MESSAGE_ENTRY_CONTENT_FIELDS.notify);
  const canonical = canonicalize({ message: content });
  return createHash("sha256").update(canonical).digest("hex");
}

export function signMessageEntry(sc: MessageEntrySignedContext, opts: SignOptions): SignResult {
  return signCanonical(sc, opts);
}

export function verifyMessageEntry(
  sc: MessageEntrySignedContext,
  v1: string,
  opts: VerifyOptions,
): VerifyResult {
  return verifyCanonical(sc, v1, opts);
}

/**
 * Fields bound by the `response` entry signature, in spec order — §9.2's key set with the mailbox
 * destination (`to`) in place of `callback_url`, and the IDENTICAL payload digest (spec §9.8).
 */
export const SIGNED_RESPONSE_ENTRY_FIELDS = [
  "id",
  "in_reply_to",
  "jti",
  "ma2h_version",
  "payload_sha256",
  "resolution",
  "resolution_id",
  "resolved_at",
  "t",
  "to",
] as const satisfies ReadonlyArray<keyof ResponseEntrySignedContext>;

export interface ResponseEntrySignedContextParts {
  /**
   * The original message id. Always equal to the Response's `in_reply_to` (spec §9.8 pins the
   * reconstruction); kept as a separate field for §9.2 key-set parity.
   */
  id: string;
  in_reply_to: string;
  jti: string;
  ma2h_version: ResponseEntrySignedContext["ma2h_version"];
  /** Identical to §9.2: computePayloadSha256(response.response, response.state). */
  payload_sha256: string;
  resolution: Resolution;
  resolution_id: string;
  /**
   * The Response's `response.resolved_at` when the detail is present; JSON `null` when a task
   * Response legitimately omits it (spec §9.8 — absent-optional-as-null, as §14.4's wrapper).
   */
  resolved_at: string | null;
  t: string | number;
  to: ResponseEntrySignedContext["to"];
}

/** Assemble the canonical response_signed_context from its parts (spec §9.8). */
export function buildResponseEntrySignedContext(
  parts: ResponseEntrySignedContextParts,
): ResponseEntrySignedContext {
  return {
    id: parts.id,
    in_reply_to: parts.in_reply_to,
    jti: parts.jti,
    ma2h_version: parts.ma2h_version,
    payload_sha256: parts.payload_sha256,
    resolution: parts.resolution,
    resolution_id: parts.resolution_id,
    resolved_at: parts.resolved_at,
    t: String(parts.t),
    to: parts.to,
  };
}

export function signResponseEntry(sc: ResponseEntrySignedContext, opts: SignOptions): SignResult {
  return signCanonical(sc, opts);
}

export function verifyResponseEntry(
  sc: ResponseEntrySignedContext,
  v1: string,
  opts: VerifyOptions,
): VerifyResult {
  return verifyCanonical(sc, v1, opts);
}

/** Fields bound by the `receipt` entry signature, in spec order (the §14.4 ack pattern). */
export const SIGNED_RECEIPT_FIELDS = [
  "in_reply_to",
  "jti",
  "ma2h_version",
  "receipt_sha256",
  "t",
  "to",
] as const satisfies ReadonlyArray<keyof ReceiptSignedContext>;

export interface ReceiptSignedContextParts {
  in_reply_to: string;
  jti: string;
  ma2h_version: ReceiptSignedContext["ma2h_version"];
  receipt_sha256: string;
  t: string | number;
  to: ReceiptSignedContext["to"];
}

/** Assemble the canonical receipt_signed_context from its parts (spec §9.8). */
export function buildReceiptSignedContext(parts: ReceiptSignedContextParts): ReceiptSignedContext {
  return {
    in_reply_to: parts.in_reply_to,
    jti: parts.jti,
    ma2h_version: parts.ma2h_version,
    receipt_sha256: parts.receipt_sha256,
    t: String(parts.t),
    to: parts.to,
  };
}

/**
 * Digest of the receipt payload, bound into the §9.8 `receipt` entry signature. Computed over the
 * fixed-key wrapper with exactly six keys — `{ at, event, id, in_reply_to, prior, session }` — any
 * absent member serialized as JSON `null` (all six are present in a v0.5 bounce receipt; the null
 * convention matches §14.4's ack_sha256 wrapper and keeps the digest unambiguous as future minors
 * add events). The receipt's `id` — its §8.7.1 ack key — is bound here, so the key a consumer acks
 * is authenticated. The verifier RECOMPUTES this from the receipt it received.
 */
export function computeReceiptSha256(receipt: ReceiptEntry): string {
  const canonical = canonicalize({
    at: receipt.at ?? null,
    event: receipt.event ?? null,
    id: receipt.id ?? null,
    in_reply_to: receipt.in_reply_to ?? null,
    prior: receipt.prior ?? null,
    session: receipt.session ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function signReceipt(sc: ReceiptSignedContext, opts: SignOptions): SignResult {
  return signCanonical(sc, opts);
}

export function verifyReceipt(sc: ReceiptSignedContext, v1: string, opts: VerifyOptions): VerifyResult {
  return verifyCanonical(sc, v1, opts);
}
