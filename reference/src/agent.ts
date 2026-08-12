// Reference agent (client) — spec §2.1, §6, §9.2/§9.3, and the v0.5 consuming bridge
// (§8.7.1 entry kinds, §9.8 verification, §13.4 duties incl. the v0.5 amendments, §16 sessions).
//
// Models the ephemeral resume flow: the agent seals state before submitting, then
// a (possibly new) process calls `onResume` when a signed Response arrives by push
// or pull. onResume verifies the signature, deduplicates, and opens the sealed
// state — treating everything on the return leg as untrusted until verified.
// `runBridgeLoop` is the v0.5 worked example: register → drain → verify → act →
// ack → close, exiting LOUD (distinct nonzero codes) on auth failure, an
// own-terminal session, or a signature failure — never a silent death.

import {
  buildInboundSignedContext,
  buildMessageEntrySignedContext,
  buildReceiptSignedContext,
  buildResponseEntrySignedContext,
  buildSignedContext,
  computeDirectivePayloadSha256,
  computeMessageEntryPayloadSha256,
  computePayloadSha256,
  computeReceiptSha256,
  verifyInbound,
  verifyMessageEntry,
  verifyReceipt,
  verifyResponse,
  verifyResponseEntry,
} from "./signing.js";
import { openState } from "./state-seal.js";
import { validateInboundMessage, validateV05 } from "./envelope.js";
import type {
  A2hResponse,
  AgentAddress,
  DirectiveTo,
  InboundDirective,
  InboxEntryDelivery,
  InterAgentMessage,
  JsonObject,
  ReceiptEntry,
  Resolution,
  Session,
} from "./types.js";

export interface ParsedSignature {
  t: string;
  jti: string;
  v1: string;
}

/** Parse an `MA2H-Signature: t=..,jti=..,v1=..` header. */
export function parseSignatureHeader(header: string): ParsedSignature {
  const body = header.replace(/^MA2H-Signature:\s*/i, "");
  const parts = new Map<string, string>();
  for (const kv of body.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) parts.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  const t = parts.get("t");
  const jti = parts.get("jti");
  const v1 = parts.get("v1");
  if (t === undefined || jti === undefined || v1 === undefined) {
    throw new Error("malformed MA2H-Signature header");
  }
  return { t, jti, v1 };
}

export type ResumeResult =
  | { acted: true; resolution: Resolution; state: JsonObject | null; value?: string | JsonObject }
  | { acted: false; reason: string };

export interface AgentOptions {
  /** This agent's own callback URL (bound into the signature). */
  callbackUrl: string;
  /** Key used to verify the Hub's Response signature. */
  callbackKey: string;
  /** Agent-owned, Hub-invisible key for sealing/opening `state` (32 bytes). */
  sealKey: Buffer;
  windowSeconds?: number;
  /**
   * Key used to verify the Hub's inbound directive signature (§9.7). MAY differ from `callbackKey`
   * (§9.7 allows same or distinct); defaults to `callbackKey` when omitted.
   */
  directiveKey?: string;
  /**
   * This agent's own `agent:<id>` identity (spec §13.4). REQUIRED to consume the inbound leg: after
   * verifying the signature, `receiveDirective` confirms `directive.to` addresses THIS agent, so a
   * directive validly signed for another agent is refused even if it reaches this stream (the webhook
   * channel has no Hub-side mailbox gate). Not needed for the response leg (`onResume`).
   */
  agentId?: DirectiveTo;
  /**
   * This invocation's CURRENT registered session (spec §16), for the v0.5 session-qualified
   * addressee check (§13.4 amendment): a validly-signed entry for a PRIOR session of the same
   * principal is refused, not acted on. Update via `setSession` after a re-registration.
   */
  session?: string;
  /**
   * The EXPLICIT deployment-declared authorization policy for which `from` principals may ask/task
   * this agent (spec §13.4 amendment, MUST): an allowlist of principals, or the deliberate
   * `"any-same-account"`. There is NO implicit default — when unset, an addressed ask/task is
   * refused before acting (verification proves origin, not intent-safety, §13.5).
   */
  senderPolicy?: string[] | "any-same-account";
}

export type DirectiveResult =
  | {
      acted: true;
      /** The directive, projected to its known schema fields — any unsigned unknown field is stripped. */
      directive: InboundDirective;
      /**
       * Finalize dedup (spec §13.4). On accept the `id` is **reserved** (in-flight) so a concurrent
       * overlapping delivery — webhook + poll, or a redelivery past the visibility timeout — is deduped
       * before either completes. The caller invokes `commit()` only AFTER it has durably processed the
       * directive (verify -> act -> `commit()` -> ack), promoting the reservation to a permanent dedup.
       */
      commit: () => void;
      /**
       * Abandon the in-flight reservation so a later redelivery may retry (spec §13.4) — for a caller
       * that failed to process but is still alive. On a crash the in-memory reservation is simply lost,
       * so a redelivery to a fresh process retries (at-least-once); an idempotent side effect or a
       * persisted dedup set gives at-most-once across a restart.
       */
      release: () => void;
    }
  | { acted: false; reason: string };

/** Split an `agent:<id>[#<session>]` address by the §4 first-`#` grammar; null when malformed. */
function splitAddress(addr: string): { principal: string; session?: string } | null {
  if (!addr.startsWith("agent:")) return null;
  const rest = addr.slice("agent:".length);
  const hash = rest.indexOf("#");
  if (hash === -1) return rest.length > 0 ? { principal: rest } : null;
  const principal = rest.slice(0, hash);
  const session = rest.slice(hash + 1);
  if (principal.length === 0 || !session.startsWith("sess_")) return null;
  return { principal, session };
}

export type MessageEntryResult =
  | {
      acted: true;
      /** The entry, projected to its known schema fields — any unsigned unknown field is stripped. */
      message: InterAgentMessage;
      /** Finalize dedup after durable processing (spec §13.4) — as DirectiveResult. */
      commit: () => void;
      /** Abandon the in-flight reservation so a later redelivery may retry (spec §13.4). */
      release: () => void;
    }
  | { acted: false; reason: string };

export type ReceiptResult = { acted: true; receipt: ReceiptEntry } | { acted: false; reason: string };

/** One drained entry's outcome, discriminated by its §8.7.1 kind. */
export type EntryResult =
  | { kind: "directive"; result: DirectiveResult }
  | { kind: "message"; result: MessageEntryResult }
  | { kind: "response"; result: ResumeResult }
  | { kind: "receipt"; result: ReceiptResult };

/** Project a message entry to its known schema fields, dropping any unsigned unknown property (§10, §13.4). */
function sanitizeMessageEntry(m: InterAgentMessage): InterAgentMessage {
  const base = {
    ma2h_version: m.ma2h_version,
    id: m.id,
    from: m.from,
    to: m.to,
    created_at: m.created_at,
    agent: m.agent, // delivered but ADVISORY (§8.7.1) — never identity or authorization
    title: m.title,
    ...(m.body !== undefined ? { body: m.body } : {}),
    ...(m.priority !== undefined ? { priority: m.priority } : {}),
    ...(m.tags !== undefined ? { tags: m.tags } : {}),
    ...(m.context !== undefined ? { context: m.context } : {}),
    ...(m.expires_at !== undefined ? { expires_at: m.expires_at } : {}),
    ...(m.sensitive !== undefined ? { sensitive: m.sensitive } : {}),
  };
  if (m.type === "ask") return { ...base, type: "ask", idempotency_key: m.idempotency_key, request: m.request };
  if (m.type === "task") return { ...base, type: "task", idempotency_key: m.idempotency_key, action: m.action };
  return { ...base, type: "notify", ...(m.idempotency_key !== undefined ? { idempotency_key: m.idempotency_key } : {}) };
}

/** Project a directive to its known schema fields, dropping any unsigned unknown property (§10, §13.4). */
function sanitizeDirective(d: InboundDirective): InboundDirective {
  const out: InboundDirective = {
    ma2h_version: d.ma2h_version,
    type: "directive",
    id: d.id,
    from: d.from,
    to: d.to,
    created_at: d.created_at,
    title: d.title,
  };
  if (d.body !== undefined) out.body = d.body;
  if (d.priority !== undefined) out.priority = d.priority;
  if (d.tags !== undefined) out.tags = d.tags;
  if (d.context !== undefined) out.context = d.context;
  if (d.expires_at !== undefined) out.expires_at = d.expires_at;
  if (d.sensitive !== undefined) out.sensitive = d.sensitive;
  return out;
}

export class Agent {
  private readonly seen = new Set<string>();
  /** At-most-once cache of directive ids the caller has COMMITTED (durably processed) — spec §13.4. */
  private readonly seenDirectives = new Set<string>();
  /** Directive ids currently RESERVED (accepted, not yet committed/released) — the in-flight guard. */
  private readonly inFlightDirectives = new Set<string>();
  /**
   * Replay cache of inbound signature `jti`s already seen (spec §9.7/§9.8) — directives and the
   * v0.5 entry kinds share it. Rejects an exact-bytes signature replay independently of the `id`
   * business-dedup. In-process and unbounded here (the minimal reference); a production agent
   * bounds it with a TTL >= the replay window.
   */
  private readonly seenDirectiveJti = new Set<string>();
  /** At-most-once cache of receipts already seen, keyed `(in_reply_to, event)` (spec §8.7.1). */
  private readonly seenReceipts = new Set<string>();
  private readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
  }

  /** Handle a Response delivered by push (or fetched by pull). At-most-once. */
  onResume(response: A2hResponse, signatureHeader: string, nowMs?: number): ResumeResult {
    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // prefix it `signature:` so the bridge's fatal classification (§13.4 loud-failure) catches it
      // — an unverifiable entry in the agent's own mailbox must never be silently skipped.
      return { acted: false, reason: `signature: ${(e as Error).message}` };
    }

    const sc = buildSignedContext({
      ma2h_version: response.ma2h_version,
      callback_url: this.opts.callbackUrl,
      id: response.in_reply_to,
      in_reply_to: response.in_reply_to,
      jti: sig.jti,
      // §9.2 (issue #7): RECOMPUTE the payload digest from the payload we actually received,
      // so a tampered value/comment/actor/state diverges the digest and fails verification.
      payload_sha256: computePayloadSha256(response.response, response.state),
      resolution: response.resolution,
      resolution_id: response.resolution_id,
      resolved_at: response.response?.resolved_at ?? "",
      t: sig.t,
    });
    const verified = verifyResponse(sc, sig.v1, {
      key: this.opts.callbackKey,
      now: nowMs ?? Date.now(),
      ...(this.opts.windowSeconds !== undefined ? { windowSeconds: this.opts.windowSeconds } : {}),
    });
    if (!verified.ok) return { acted: false, reason: `signature: ${verified.reason}` };

    const dedupKey = `${response.in_reply_to}::${response.resolution_id}`;
    if (this.seen.has(dedupKey)) return { acted: false, reason: "duplicate delivery (already acted)" };

    // Open sealed state ONLY after signature verification; reject tamper.
    let state: JsonObject | null = null;
    const sealed = response.state?.["sealed"];
    if (typeof sealed === "string") {
      try {
        state = openState(sealed, this.opts.sealKey);
      } catch (e) {
        return { acted: false, reason: (e as Error).message };
      }
    }

    this.seen.add(dedupKey); // commit only once we will actually act
    return {
      acted: true,
      resolution: response.resolution,
      state,
      ...(response.response?.value !== undefined ? { value: response.response.value } : {}),
    };
  }

  /**
   * Handle a directive drained from the mailbox (or pushed by webhook). Verifies the §9.7 signature by
   * RECOMPUTING `payload_sha256` from the directive it received (so a tampered from/to/body diverges the
   * digest), enforces the replay window, and deduplicates on the directive `id` (§13.4) so a redelivered
   * directive is acted on at most once. Untrusted until verified.
   */
  receiveDirective(directive: InboundDirective, signatureHeader: string, nowMs?: number): DirectiveResult {
    // §13.4: a conformant inbound consumer MUST know its own identity to check the addressee.
    const self = this.opts.agentId;
    if (self === undefined) {
      return { acted: false, reason: "agent identity (agentId) not configured — cannot verify the directive addressee (§13.4)" };
    }

    // Validate SHAPE first (before any hashing): a malformed wire object (e.g. missing `title`) would
    // otherwise reach computeDirectivePayloadSha256 and throw in the JCS canonicalizer instead of a clean
    // refusal. The schema also forbids `request`/`action`/`state` — `payload_sha256` binds only the
    // content fields, so an on-path injector can add cross-type data without breaking the signature.
    const shape = validateInboundMessage(directive);
    if (!shape.valid) return { acted: false, reason: `invalid directive: ${shape.errors.join("; ")}` };

    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // prefix it `signature:` so the bridge's fatal classification (§13.4 loud-failure) catches it
      // — an unverifiable entry in the agent's own mailbox must never be silently skipped.
      return { acted: false, reason: `signature: ${(e as Error).message}` };
    }

    const sc = buildInboundSignedContext({
      from: directive.from,
      id: directive.id,
      jti: sig.jti,
      ma2h_version: directive.ma2h_version,
      // §9.7: recompute from the directive we actually received — never trust a transmitted digest.
      payload_sha256: computeDirectivePayloadSha256(directive),
      t: sig.t,
      to: directive.to,
    });
    const verified = verifyInbound(sc, sig.v1, {
      key: this.opts.directiveKey ?? this.opts.callbackKey,
      now: nowMs ?? Date.now(),
      ...(this.opts.windowSeconds !== undefined ? { windowSeconds: this.opts.windowSeconds } : {}),
    });
    if (!verified.ok) return { acted: false, reason: `signature: ${verified.reason}` };

    // §13.4: confirm this directive is addressed to THIS agent. The signature binds `to`, so a valid
    // signature proves the Hub intended a specific addressee — but only the recipient checking the
    // addressee stops a directive validly signed for agent:X from being acted on by agent:Y (the
    // webhook channel has no Hub-side mailbox gate; the pull mailbox enforces this Hub-side too).
    // A v0.5 directive MAY be SESSION-addressed (§13.2), so the check honors the §13.4 amendment
    // exactly as `receiveMessageEntry`: `to`'s principal must be this agent AND, when
    // session-qualified, the named session must be this invocation's own CURRENT session — a
    // directive for a prior own session is refused, not acted on. (A bare `agent:<id>` matches any
    // session; a legacy `#`-bearing addressee that splitAddress cannot parse falls back to exact.)
    const toAddr = splitAddress(directive.to);
    if (toAddr === null ? directive.to !== self : `agent:${toAddr.principal}` !== self) {
      return { acted: false, reason: `addressee mismatch: directive.to ${directive.to} != ${self}` };
    }
    if (toAddr?.session !== undefined && toAddr.session !== this.opts.session) {
      return {
        acted: false,
        reason: `addressee session mismatch: ${toAddr.session} is not this invocation's current session (§13.4)`,
      };
    }

    // §9.7: reject an exact-bytes signature replay (same jti) independently of the id business-dedup.
    if (this.seenDirectiveJti.has(sig.jti)) {
      return { acted: false, reason: "replay: jti already seen" };
    }
    // id dedup — committed (already processed) beats in-flight (a concurrent/overlapping delivery).
    if (this.seenDirectives.has(directive.id)) {
      return { acted: false, reason: "duplicate delivery (already acted)" };
    }
    if (this.inFlightDirectives.has(directive.id)) {
      return { acted: false, reason: "duplicate delivery (in flight)" };
    }

    // Commit the jti now — the same signed bytes must never be re-accepted. RESERVE the id in-flight so
    // a concurrent same-id delivery is deduped before either completes; the caller promotes it to a
    // permanent dedup via commit() after durable processing, or release()s it to allow a retry (§13.4).
    this.seenDirectiveJti.add(sig.jti);
    const id = directive.id;
    this.inFlightDirectives.add(id);
    return {
      acted: true,
      directive: sanitizeDirective(directive), // §10/§13.4: strip any unsigned unknown field
      commit: () => {
        this.seenDirectives.add(id);
        this.inFlightDirectives.delete(id);
      },
      release: () => this.inFlightDirectives.delete(id),
    };
  }

  // ---- v0.5 inter-agent entry consumption (spec §8.7.1, §9.8, §13.4 applied wholesale) ----

  /** Update this invocation's current session (after a §16 re-registration). */
  setSession(sessionId: string | undefined): void {
    if (sessionId === undefined) delete this.opts.session;
    else this.opts.session = sessionId;
  }

  /** This agent's own principal (its `agent:<id>` minus the scheme), when configured. */
  private ownPrincipal(): string | undefined {
    return this.opts.agentId?.slice("agent:".length);
  }

  /**
   * Handle a `message` entry drained from the session-scoped mailbox (spec §8.7.1). The §13.4
   * duties apply WHOLESALE, with the v0.5 amendments: shape-validate against the delivered-entry
   * schema (the §9.8 digest binds only content fields — unsigned injected `state`/`client_ref`/
   * callbacks must be rejected, not acted on), verify the §9.8 signature by RECOMPUTING the payload
   * digest, confirm the addressee INCLUDING the session qualifier (an entry for a prior own session
   * is refused), evaluate the explicit deployment-declared sender policy before acting on an
   * ask/task, dedup on `id` with the in-flight reservation, and strip to known fields.
   */
  receiveMessageEntry(message: InterAgentMessage, signatureHeader: string, nowMs?: number): MessageEntryResult {
    const self = this.ownPrincipal();
    if (self === undefined) {
      return { acted: false, reason: "agent identity (agentId) not configured — cannot verify the addressee (§13.4)" };
    }
    const shape = validateV05("inbound-message.schema.json", message);
    if (!shape.valid) return { acted: false, reason: `invalid message entry: ${shape.errors.join("; ")}` };

    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // prefix it `signature:` so the bridge's fatal classification (§13.4 loud-failure) catches it
      // — an unverifiable entry in the agent's own mailbox must never be silently skipped.
      return { acted: false, reason: `signature: ${(e as Error).message}` };
    }
    const sc = buildMessageEntrySignedContext({
      from: message.from,
      id: message.id,
      jti: sig.jti,
      ma2h_version: message.ma2h_version,
      // §9.8: recompute from the entry we actually received — never trust a transmitted digest.
      payload_sha256: computeMessageEntryPayloadSha256(message),
      t: sig.t,
      to: message.to,
    });
    const verified = verifyMessageEntry(sc, sig.v1, {
      key: this.opts.directiveKey ?? this.opts.callbackKey,
      now: nowMs ?? Date.now(),
      ...(this.opts.windowSeconds !== undefined ? { windowSeconds: this.opts.windowSeconds } : {}),
    });
    if (!verified.ok) return { acted: false, reason: `signature: ${verified.reason}` };

    // §13.4 amendment: the addressee check extends to the session qualifier — `to`'s principal must
    // be this agent AND, when session-qualified, the named session must be its own CURRENT session.
    const to = splitAddress(message.to);
    if (to === null || to.principal !== self) {
      return { acted: false, reason: `addressee mismatch: message.to ${message.to} != agent:${self}` };
    }
    if (to.session !== undefined && to.session !== this.opts.session) {
      return {
        acted: false,
        reason: `addressee session mismatch: ${to.session} is not this invocation's current session (§13.4)`,
      };
    }

    if (this.seenDirectiveJti.has(sig.jti)) return { acted: false, reason: "replay: jti already seen" };

    // §13.4 amendment (MUST): an EXPLICIT deployment-declared policy gates acting on an addressed
    // ask/task — no implicit default. A notify carries no request/action surface and is exempt.
    if (message.type !== "notify") {
      const policy = this.opts.senderPolicy;
      const from = splitAddress(message.from);
      if (policy === undefined) {
        return { acted: false, reason: "no declared sender policy — refusing to act on an addressed ask/task (§13.4)" };
      }
      if (policy !== "any-same-account" && (from === null || !policy.includes(from.principal))) {
        return { acted: false, reason: `sender ${message.from} is not in the declared policy (§13.4)` };
      }
    }

    if (this.seenDirectives.has(message.id)) return { acted: false, reason: "duplicate delivery (already acted)" };
    if (this.inFlightDirectives.has(message.id)) return { acted: false, reason: "duplicate delivery (in flight)" };

    this.seenDirectiveJti.add(sig.jti);
    const id = message.id;
    this.inFlightDirectives.add(id);
    return {
      acted: true,
      message: sanitizeMessageEntry(message), // §10/§13.4: strip any unsigned unknown field
      commit: () => {
        this.seenDirectives.add(id);
        this.inFlightDirectives.delete(id);
      },
      release: () => this.inFlightDirectives.delete(id),
    };
  }

  /**
   * Handle a `response` entry drained from the session-scoped mailbox (spec §8.7.1) — the §6
   * Response as a mailbox entry. The §9.8 context is RECONSTRUCTED from the verifier's own
   * identity: `to` from its principal + the session it presented on the drain, `id` from the
   * delivered `in_reply_to`, `resolved_at` as JSON null when the detail is absent. Dedups on
   * `(in_reply_to, resolution_id)` — shared with `onResume`, so the same Response arriving by
   * push/pull and by entry is acted on once.
   */
  receiveResponseEntry(response: A2hResponse, signatureHeader: string, nowMs?: number): ResumeResult {
    const self = this.ownPrincipal();
    if (self === undefined || this.opts.session === undefined) {
      return { acted: false, reason: "agent identity + current session required to reconstruct the §9.8 context" };
    }
    // §8.7.1: a consuming agent MUST validate the delivered payload's shape before acting — the
    // sibling directive/message/receipt handlers all do. Validate against the v0.5 response entry
    // shape before hashing so a malformed body is refused cleanly, not fed to the canonicalizer.
    const shape = validateV05("response.schema.json", response);
    if (!shape.valid) return { acted: false, reason: `invalid response entry: ${shape.errors.join("; ")}` };
    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // prefix it `signature:` so the bridge's fatal classification (§13.4 loud-failure) catches it
      // — an unverifiable entry in the agent's own mailbox must never be silently skipped.
      return { acted: false, reason: `signature: ${(e as Error).message}` };
    }
    const sc = buildResponseEntrySignedContext({
      id: response.in_reply_to,
      in_reply_to: response.in_reply_to,
      jti: sig.jti,
      ma2h_version: response.ma2h_version,
      payload_sha256: computePayloadSha256(response.response, response.state),
      resolution: response.resolution,
      resolution_id: response.resolution_id,
      resolved_at: response.response?.resolved_at ?? null,
      t: sig.t,
      to: `agent:${self}#${this.opts.session}` as AgentAddress,
    });
    const verified = verifyResponseEntry(sc, sig.v1, {
      key: this.opts.directiveKey ?? this.opts.callbackKey,
      now: nowMs ?? Date.now(),
      ...(this.opts.windowSeconds !== undefined ? { windowSeconds: this.opts.windowSeconds } : {}),
    });
    if (!verified.ok) return { acted: false, reason: `signature: ${verified.reason}` };
    if (this.seenDirectiveJti.has(sig.jti)) return { acted: false, reason: "replay: jti already seen" };
    this.seenDirectiveJti.add(sig.jti);

    const dedupKey = `${response.in_reply_to}::${response.resolution_id}`;
    if (this.seen.has(dedupKey)) return { acted: false, reason: "duplicate delivery (already acted)" };

    let state: JsonObject | null = null;
    const sealed = response.state?.["sealed"];
    if (typeof sealed === "string") {
      try {
        state = openState(sealed, this.opts.sealKey);
      } catch (e) {
        return { acted: false, reason: (e as Error).message };
      }
    }
    this.seen.add(dedupKey);
    return {
      acted: true,
      resolution: response.resolution,
      state,
      ...(response.response?.value !== undefined ? { value: response.response.value } : {}),
    };
  }

  /**
   * Handle a `receipt` entry (spec §8.7.1): verify (§9.8 — an unverified receipt could fabricate a
   * bounce and trick a sender into abandoning a live ask), dedup on `(in_reply_to, event)`.
   * Receipts drive NO action and never generate receipts; the sender's §8.2 pull remains
   * authoritative. The context's `to` is RECONSTRUCTED from this verifier's own drain identity —
   * never from the wire (the received receipt's body `to` is routing convenience, not verification
   * input) — so a cross-destination replay fails the signature itself (dp-016/dp-017).
   */
  receiveReceipt(receipt: ReceiptEntry, signatureHeader: string, nowMs?: number): ReceiptResult {
    const self = this.ownPrincipal();
    if (self === undefined || this.opts.session === undefined) {
      return { acted: false, reason: "agent identity + current session required to reconstruct the §9.8 context" };
    }
    const shape = validateV05("inbound-message.schema.json", receipt);
    if (!shape.valid) return { acted: false, reason: `invalid receipt: ${shape.errors.join("; ")}` };
    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // prefix it `signature:` so the bridge's fatal classification (§13.4 loud-failure) catches it
      // — an unverifiable entry in the agent's own mailbox must never be silently skipped.
      return { acted: false, reason: `signature: ${(e as Error).message}` };
    }
    const sc = buildReceiptSignedContext({
      in_reply_to: receipt.in_reply_to,
      jti: sig.jti,
      ma2h_version: receipt.ma2h_version,
      // §9.8: recompute over the fixed six-key wrapper from the receipt we received.
      receipt_sha256: computeReceiptSha256(receipt),
      t: sig.t,
      to: `agent:${self}#${this.opts.session}` as AgentAddress,
    });
    const verified = verifyReceipt(sc, sig.v1, {
      key: this.opts.directiveKey ?? this.opts.callbackKey,
      now: nowMs ?? Date.now(),
      ...(this.opts.windowSeconds !== undefined ? { windowSeconds: this.opts.windowSeconds } : {}),
    });
    if (!verified.ok) return { acted: false, reason: `signature: ${verified.reason}` };
    if (this.seenDirectiveJti.has(sig.jti)) return { acted: false, reason: "replay: jti already seen" };
    this.seenDirectiveJti.add(sig.jti);
    const dedupKey = `${receipt.in_reply_to}::${receipt.event}`;
    if (this.seenReceipts.has(dedupKey)) return { acted: false, reason: "duplicate receipt (already seen)" };
    this.seenReceipts.add(dedupKey);
    return { acted: true, receipt };
  }

  /** Dispatch one drained §8.7.1 entry to its kind's handler (spec §13.4). */
  receiveEntry(delivery: InboxEntryDelivery, nowMs?: number): EntryResult {
    if ("directive" in delivery) {
      return { kind: "directive", result: this.receiveDirective(delivery.directive, delivery.signature, nowMs) };
    }
    if ("message" in delivery) {
      return { kind: "message", result: this.receiveMessageEntry(delivery.message, delivery.signature, nowMs) };
    }
    if ("response" in delivery) {
      return { kind: "response", result: this.receiveResponseEntry(delivery.response, delivery.signature, nowMs) };
    }
    return { kind: "receipt", result: this.receiveReceipt(delivery.receipt, delivery.signature, nowMs) };
  }
}

// ---- The v0.5 bridge loop — the worked example (spec §8.7.1, §13.4, §16) ----
//
// register session → bounded-hold drain (each iteration models one long-poll hold + the reconnect
// that renews the lease, §16.2) → verify per §13.4 incl. the session-qualified addressee check →
// declared-policy check → act (resolve an addressed ask/task via §8.8) → ack with `?session=` →
// close. Failure discipline: LOUD, NEVER SILENT — distinct nonzero exit codes for the three
// fatal classes, so a supervisor can tell "fix credentials" from "lease lapsed, re-register" from
// "someone is tampering". (A production bridge would typically RE-register on the own-session 410,
// §16.3 — the worked example exits with the distinct code so the operator sees the lease lapsed.)

/** Auth failure: the credential was rejected or is not authorized (§9.1). */
export const EXIT_AUTH_FAILURE = 2;
/** Own-but-terminal session on drain/ack (§8.7.1's 410): the lease lapsed or was kill-switched. */
export const EXIT_SESSION_TERMINAL = 3;
/** An entry in the OWN mailbox failed §9.7/§9.8 verification — possible tampering. */
export const EXIT_SIGNATURE_FAILURE = 4;

/** A fatal bridge failure, carrying the distinct nonzero process exit code (never 0). */
export class BridgeExitError extends Error {
  constructor(
    public readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeExitError";
  }
}

/** The Hub surface the bridge drives — structural, so tests can stub failure transports. */
export interface BridgeHub {
  registerSession(
    principal: string,
    req?: { run_id?: string; label?: string; kind?: string; ttl_seconds?: number },
    nowMs?: number,
  ): { session: Session };
  drainInbox(
    principal: string,
    opts: { max?: number; now?: number; session: string },
  ): InboxEntryDelivery[];
  ackInbox(
    principal: string,
    ids: string[],
    opts?: { note?: string; now?: number; session?: string },
  ): { acked: number };
  closeSession(sessionId: string, caller: string, nowMs?: number): { session: Session };
  resolveAsAgent(
    id: string,
    principal: string,
    body: {
      resolution: "answered" | "declined" | "completed" | "dismissed";
      value?: string | JsonObject;
      comment?: string;
      checklist?: { text: string; done: boolean }[];
    },
    opts?: { session?: string; now?: number },
  ): unknown;
}

/** What the bridge should do with a verified, policy-passed `message` entry (the "act" step). */
export type BridgeDecide = (message: InterAgentMessage) => {
  resolution: "answered" | "declined" | "completed" | "dismissed";
  value?: string | JsonObject;
  comment?: string;
  checklist?: { text: string; done: boolean }[];
} | void;

export interface BridgeOptions {
  /** The bridge's own `agent.id` (its credential identity). */
  principal: string;
  /** The Agent instance that verifies (§9.7/§9.8) and dedups (§13.4). */
  agent: Agent;
  /** The act step for addressed ask/task entries; a void return acks without resolving. */
  decide?: BridgeDecide;
  /** Bounded number of drain holds (each models one long-poll + reconnect-renewal). Default 3. */
  maxDrains?: number;
  /** Session registration knobs (label/ttl), passed through to §16.1. */
  register?: { run_id?: string; label?: string; kind?: string; ttl_seconds?: number };
  now?: () => number;
}

export interface BridgeReport {
  /** The session this run registered (and closed, unless it exited early). */
  session: string;
  processed: { directives: number; messages: number; responses: number; receipts: number };
  /** Entries refused without acting (policy/addressee/dedup refusals) — left to redelivery. */
  refused: string[];
  closed: boolean;
}

/** Map a Hub error to the pinned exit codes; anything unmapped rethrows as itself (still loud). */
function mapHubError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === "unauthenticated" || code === "not_authorized" || code === "agent_id_mismatch") {
    throw new BridgeExitError(EXIT_AUTH_FAILURE, `auth failure: ${(e as Error).message}`);
  }
  if (code === "gone") {
    throw new BridgeExitError(EXIT_SESSION_TERMINAL, `own session is terminal: ${(e as Error).message}`);
  }
  throw e;
}

/**
 * Run the bridge loop once, end to end. Throws `BridgeExitError` (with the distinct code) on the
 * three fatal classes; every other Hub error propagates unwrapped. Never returns "success" having
 * swallowed a failure.
 */
export function runBridgeLoop(hub: BridgeHub, opts: BridgeOptions): BridgeReport {
  const now = opts.now ?? ((): number => Date.now());
  const report: BridgeReport = {
    session: "",
    processed: { directives: 0, messages: 0, responses: 0, receipts: 0 },
    refused: [],
    closed: false,
  };

  // 1. Register this invocation's session (§16.1) — its address for the run.
  let sessionId: string;
  try {
    sessionId = hub.registerSession(opts.principal, opts.register, now()).session.id;
  } catch (e) {
    mapHubError(e);
  }
  report.session = sessionId;
  opts.agent.setSession(sessionId);

  // 2. Bounded drain loop: each iteration is one long-poll hold; issuing the next drain is the
  //    reconnect that renews the lease (§16.2) — no heartbeat endpoint exists by design.
  const drains = opts.maxDrains ?? 3;
  for (let i = 0; i < drains; i++) {
    let entries: InboxEntryDelivery[];
    try {
      entries = hub.drainInbox(opts.principal, { session: sessionId, now: now() });
    } catch (e) {
      mapHubError(e);
    }
    const toAck: string[] = [];
    for (const delivery of entries) {
      const outcome = opts.agent.receiveEntry(delivery, now());
      const r = outcome.result;
      if (!r.acted) {
        // §13.4 discipline: a failed VERIFICATION is fatal and loud — an entry in the bridge's own
        // mailbox that does not verify means tampering or a broken Hub, never something to skip
        // past. Dedup refusals are benign (the work already happened durably): ack the redelivery.
        if (r.reason.startsWith("signature:") || r.reason.startsWith("replay:")) {
          throw new BridgeExitError(EXIT_SIGNATURE_FAILURE, `entry failed verification: ${r.reason}`);
        }
        if (r.reason.includes("already acted") || r.reason.includes("already seen")) {
          toAck.push(ackKeyOf(delivery)); // benign redelivery: the work already happened durably
        } else {
          report.refused.push(r.reason); // policy / addressee refusals: never acted on, never acked
        }
        continue;
      }
      // 3. Act, then consume (verify → policy → act durably → commit dedup → ack, §13.4).
      if (outcome.kind === "message" && outcome.result.acted) {
        const m = outcome.result.message;
        if (m.type !== "notify" && opts.decide) {
          const decision = opts.decide(m);
          if (decision) {
            try {
              hub.resolveAsAgent(m.id, opts.principal, decision, { session: sessionId, now: now() });
            } catch (e) {
              // Losing the §7 CAS race is a normal outcome (the 409 carries the real terminal);
              // everything else maps to the loud exits.
              if ((e as { code?: string }).code !== "already_terminal") mapHubError(e);
            }
          }
        }
        outcome.result.commit();
        report.processed.messages++;
      } else if (outcome.kind === "directive" && outcome.result.acted) {
        outcome.result.commit();
        report.processed.directives++;
      } else if (outcome.kind === "response") {
        report.processed.responses++;
      } else if (outcome.kind === "receipt") {
        report.processed.receipts++;
      }
      toAck.push(ackKeyOf(delivery));
    }
    if (toAck.length > 0) {
      try {
        // Ack presenting the session (§8.7): during a held stream this may be the bridge's only
        // client-originated traffic, and a session-less ack renews no lease.
        hub.ackInbox(opts.principal, toAck, { session: sessionId, now: now() });
      } catch (e) {
        mapHubError(e);
      }
    }
  }

  // 4. Close the session (§16.3): an orderly exit bounces nothing later and frees the cap.
  try {
    hub.closeSession(sessionId, opts.principal, now());
  } catch (e) {
    mapHubError(e);
  }
  report.closed = true;
  return report;
}

/** The §8.7.1 ack key of one drained entry. */
function ackKeyOf(delivery: InboxEntryDelivery): string {
  if ("directive" in delivery) return delivery.directive.id;
  if ("message" in delivery) return delivery.message.id;
  if ("response" in delivery) return delivery.response.resolution_id;
  return delivery.receipt.id;
}
