// The vendorable consuming-client layer (keyed side) — spec §13.4 (consumer duties, incl. the
// v0.5 amendments), §8.7.1 (entry kinds + ack keys), §16 (sessions); issue #45.
//
// The §13.4 duty machinery every conformant consumer re-implements — the `Agent` embodiment, its
// result types, the sanitizers, the signature-header and address parsers, the ack-key rule, and
// the `BridgeHub` transport seam — moved VERBATIM from `agent.ts`, so downstream imports the one
// definition instead of re-deriving it (the drift class oh-hai#711/#712 documents).
//
// THE COVENANT (placement is API): downstream re-vendors this surface per-file with subpath
// exports, so after landing NO export may be renamed and NO symbol may be relocated to another
// module — relocating a symbol breaks a vendored import exactly as a rename would.
//
// Ordering, preserved as implemented: the reference schema-validates BEFORE verifying the
// signature — a malformed wire object must refuse cleanly instead of throwing inside the JCS
// canonicalizer — a documented deviation from §13.4's listed order, not a hidden one. The
// previously-private helpers exported here are DUTY-ORDER-SENSITIVE: each doc comment states
// which prior §13.4 duties it assumes already ran, and out-of-order composition by a consumer is
// an accepted, explicitly-flagged risk of exporting them — the `Agent` class remains the
// order-enforcing embodiment.
//
// Keyed vs keyless: this keyed embodiment RECOMPUTES every payload digest from the payload it
// actually received (§9.2/§9.7/§9.8), never trusting a transmitted digest. A keyless HTTP
// consumer cannot perform that recompute — the MAC is Hub-keyed — and compensates with the
// exported field rules; whether that compensation satisfies §13.4's unconditional recompute MUST
// is an open spec question, deferred upstream.
//
// This module mints NO Hub errors: `test/errors.test.ts`'s emitter floor scans `src/` flat, and
// every `HubError` construction site belongs to the Hub, not the client layer — keep it that way.

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

// ---- The §13.4 verdict taxonomy (issue #45, R4) ----

/**
 * The four dispositions of one consumed entry's outcome (spec §13.4 applied to the §8.7.1 entry
 * kinds) — the classification every consuming loop must make before it may act, ack, or exit:
 *
 * - `fatal-verification` — the entry failed the VERIFICATION step itself: §9.7/§9.8 signature
 *   failure, a `jti` replay, or wire-shape validation of the Hub's own output. Tampering or a
 *   broken Hub — never something to skip past. Never acked.
 * - `benign-redelivery` — an at-least-once redelivery of work that already durably happened
 *   (the committed §13.4 dedup): ack it (key via `ackKeyOf(delivery)`) without re-acting.
 * - `refused` — verified (or verifiable) but not acted on: addressee/session mismatch, sender
 *   policy, missing consumer configuration, an unopenable state seal, or an in-flight duplicate.
 *   Never acked — left to redelivery.
 * - `accepted` — verified, policy-passed, and acted on: act durably, `commit()`, then ack.
 *
 * Minted as a STRUCTURED code (the optional `disposition` field on the result types) at every
 * refusal/acceptance site; the `reason` string is PRESENTATION — unstable (it interpolates raw
 * `Error` messages) and never to be parsed by consumers. `classifyEntryResult` is the exported
 * evaluation; act/ack/emit policy stays with each consumer.
 */
export type EntryDisposition = "fatal-verification" | "benign-redelivery" | "refused" | "accepted";

/** The disposition codes an `acted: false` refusal branch may carry (everything but `accepted`). */
export type RefusalDisposition = Exclude<EntryDisposition, "accepted">;

export type ResumeResult =
  | {
      acted: true;
      /** Structured §13.4 disposition code (issue #45, R4); always `"accepted"` when minted here. */
      disposition?: "accepted";
      resolution: Resolution;
      state: JsonObject | null;
      value?: string | JsonObject;
    }
  | {
      acted: false;
      /** Structured §13.4 disposition code (issue #45, R4) — the classifier keys on this, not on `reason`. */
      disposition?: RefusalDisposition;
      reason: string;
    };

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
      /** Structured §13.4 disposition code (issue #45, R4); always `"accepted"` when minted here. */
      disposition?: "accepted";
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
  | {
      acted: false;
      /** Structured §13.4 disposition code (issue #45, R4) — the classifier keys on this, not on `reason`. */
      disposition?: RefusalDisposition;
      reason: string;
    };

/**
 * Split an `agent:<id>[#<session>]` address by the §4 first-`#` grammar; null when malformed.
 *
 * Duty order (§13.4): pure parsing only — this verifies nothing. Parsing an address is NOT the
 * addressee check; that check must compare a SIGNATURE-VERIFIED entry's `to` against the
 * consumer's own identity (and current session, when qualified), as the `Agent` handlers do after
 * §9.7/§9.8 verification.
 */
export function splitAddress(addr: string): { principal: string; session?: string } | null {
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
      /** Structured §13.4 disposition code (issue #45, R4); always `"accepted"` when minted here. */
      disposition?: "accepted";
      /** The entry, projected to its known schema fields — any unsigned unknown field is stripped. */
      message: InterAgentMessage;
      /** Finalize dedup after durable processing (spec §13.4) — as DirectiveResult. */
      commit: () => void;
      /** Abandon the in-flight reservation so a later redelivery may retry (spec §13.4). */
      release: () => void;
    }
  | {
      acted: false;
      /** Structured §13.4 disposition code (issue #45, R4) — the classifier keys on this, not on `reason`. */
      disposition?: RefusalDisposition;
      reason: string;
    };

export type ReceiptResult =
  | {
      acted: true;
      /** Structured §13.4 disposition code (issue #45, R4); always `"accepted"` when minted here. */
      disposition?: "accepted";
      receipt: ReceiptEntry;
    }
  | {
      acted: false;
      /** Structured §13.4 disposition code (issue #45, R4) — the classifier keys on this, not on `reason`. */
      disposition?: RefusalDisposition;
      reason: string;
    };

/** One drained entry's outcome, discriminated by its §8.7.1 kind. */
export type EntryResult =
  | { kind: "directive"; result: DirectiveResult }
  | { kind: "message"; result: MessageEntryResult }
  | { kind: "response"; result: ResumeResult }
  | { kind: "receipt"; result: ReceiptResult };

/**
 * One classified entry outcome — the §13.4 verdict as a DISCRIMINATED UNION over the four
 * dispositions, shaped so a TypeScript consumer is forced to handle every disposition.
 *
 * THE CONSUMPTION CONTRACT is an exhaustive switch closed by a `never`-assertion:
 *
 * ```ts
 * const verdict = classifyEntryResult(agent.receiveEntry(delivery));
 * switch (verdict.disposition) {
 *   case "fatal-verification": throw new Error(verdict.reason); // loud — never skip past
 *   case "benign-redelivery":  ack(ackKeyOf(delivery)); break;  // already durably done
 *   case "refused":            report(verdict.reason); break;   // no ack — leave to redelivery
 *   case "accepted":           act(); commit(); ack(ackKeyOf(delivery)); break;
 *   default: { const unhandled: never = verdict; throw unhandled; }
 * }
 * ```
 *
 * A HANDLING default branch is the misuse this union exists to reject: writing
 * `default: report(verdict.reason)` instead folds `fatal-verification` into refused-and-continue,
 * and the loop silently keeps consuming a mailbox AFTER a signature failure — the drift class
 * (oh-hai#711/#712) this layer exists to kill. The `never`-assertion keeps the check honest:
 * when a future spec version adds a fifth disposition, every consumer fails TYPECHECK at its
 * switch instead of routing the new disposition through whatever its default happened to do.
 *
 * The verdict deliberately carries NO ack key — an `EntryResult` does not carry the entry id (a
 * benign-redelivery result is `{ acted: false, reason }` only). Consumers take the key from
 * `ackKeyOf(delivery)`, exactly as the reference loop does.
 */
export type EntryVerdict =
  | { disposition: "fatal-verification"; reason: string }
  | { disposition: "benign-redelivery"; reason: string }
  | { disposition: "refused"; reason: string }
  | { disposition: "accepted" };

/**
 * Classify one consumed entry's outcome into its §13.4 disposition (issue #45, R4).
 *
 * Keyed on the STRUCTURED `disposition` code minted at each refusal/acceptance site — the code is
 * authoritative even when the presentation text superficially resembles another class (reasons
 * interpolate raw `Error` messages and are documented as unstable). For a result minted WITHOUT a
 * code (older or third-party minting against the pre-#45 result shapes), the reason string is
 * parsed as a documented FALLBACK with **fatal-before-benign precedence explicit**: the fatal
 * prefixes (`signature:`, `replay:`, `invalid `) are checked BEFORE the benign substrings
 * (`already acted`, `already seen`), because `"replay: jti already seen"` matches both — a replay
 * refusal MUST classify `fatal-verification`, never `benign-redelivery` (acking a replayed
 * signature as benign would consume mail the verification step rejected).
 *
 * The in-flight duplicate (`duplicate delivery (in flight)`) classifies `refused`, NOT benign —
 * frozen reference behavior with a real concurrency nuance: the overlapping first delivery has
 * not yet committed, so its work is not durably done; acking the overlap would discard the
 * redelivery a crashed first attempt needs to retry. Only the COMMITTED dedup
 * (`already acted` / `already seen`) is a benign redelivery.
 *
 * Duty order (§13.4): pure evaluation over an already-produced result — it verifies nothing and
 * acks nothing. Act/ack/exit policy on the verdict stays with the consumer (see `EntryVerdict`'s
 * consumption contract).
 */
export function classifyEntryResult(outcome: EntryResult): EntryVerdict {
  const r = outcome.result;
  if (r.acted) return { disposition: "accepted" };
  if (r.disposition !== undefined) return { disposition: r.disposition, reason: r.reason };
  // Fallback for unminted results only — FATAL BEFORE BENIGN (see the doc comment above).
  if (r.reason.startsWith("signature:") || r.reason.startsWith("replay:") || r.reason.startsWith("invalid ")) {
    return { disposition: "fatal-verification", reason: r.reason };
  }
  if (r.reason.includes("already acted") || r.reason.includes("already seen")) {
    return { disposition: "benign-redelivery", reason: r.reason };
  }
  return { disposition: "refused", reason: r.reason };
}

/**
 * Project a message entry to its known schema fields, dropping any unsigned unknown property (§10, §13.4).
 *
 * Duty order (§13.4): the strip is the LAST duty. This assumes schema validation, §9.8 signature
 * verification, the session-qualified addressee check, and the declared sender policy already ran
 * and passed — sanitizing an unverified entry launders unauthenticated input into a
 * trusted-looking shape.
 */
export function sanitizeMessageEntry(m: InterAgentMessage): InterAgentMessage {
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

/**
 * Project a directive to its known schema fields, dropping any unsigned unknown property (§10, §13.4).
 *
 * Duty order (§13.4): the strip is the LAST duty. This assumes schema validation, §9.7 signature
 * verification, the addressee check, and replay/dedup already ran and passed — sanitizing an
 * unverified directive launders unauthenticated input into a trusted-looking shape.
 */
export function sanitizeDirective(d: InboundDirective): InboundDirective {
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
      // the structured code (with the `signature:` presentation prefix) puts it in the fatal
      // classification (§13.4 loud-failure) — an unverifiable entry in the agent's own mailbox
      // must never be silently skipped.
      return { acted: false, disposition: "fatal-verification", reason: `signature: ${(e as Error).message}` };
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
    if (!verified.ok) return { acted: false, disposition: "fatal-verification", reason: `signature: ${verified.reason}` };

    const dedupKey = `${response.in_reply_to}::${response.resolution_id}`;
    if (this.seen.has(dedupKey)) {
      return { acted: false, disposition: "benign-redelivery", reason: "duplicate delivery (already acted)" };
    }

    // Open sealed state ONLY after signature verification; reject tamper.
    let state: JsonObject | null = null;
    const sealed = response.state?.["sealed"];
    if (typeof sealed === "string") {
      try {
        state = openState(sealed, this.opts.sealKey);
      } catch (e) {
        // `refused`, not fatal (frozen behavior): the §9.2 signature verified — the recomputed
        // digest covers `state` — so an unopenable seal is an agent-side key problem, not tamper.
        return { acted: false, disposition: "refused", reason: (e as Error).message };
      }
    }

    this.seen.add(dedupKey); // commit only once we will actually act
    return {
      acted: true,
      disposition: "accepted",
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
      return {
        acted: false,
        disposition: "refused",
        reason: "agent identity (agentId) not configured — cannot verify the directive addressee (§13.4)",
      };
    }

    // Validate SHAPE first (before any hashing): a malformed wire object (e.g. missing `title`) would
    // otherwise reach computeDirectivePayloadSha256 and throw in the JCS canonicalizer instead of a clean
    // refusal. The schema also forbids `request`/`action`/`state` — `payload_sha256` binds only the
    // content fields, so an on-path injector can add cross-type data without breaking the signature.
    // Version-aware (§10): a >= 0.5 directive validates against the v0.5 schema, which makes the
    // `dir_` ack-key namespace and the first-`#` address grammar NORMATIVE (the v0.4 schema does not
    // enforce them) — otherwise a signed v0.5 directive with a colliding id or a malformed qualifier
    // could pass before the session-qualified addressee check even interprets the address.
    const dv = /^0\.(0|[1-9]\d*)$/.exec(directive.ma2h_version);
    const shape =
      dv !== null && Number(dv[1]) >= 5
        ? validateV05("inbound-message.schema.json", directive)
        : validateInboundMessage(directive);
    if (!shape.valid) {
      // Shape validation of the Hub's own output is part of the §8.7.1 verification step: fatal.
      return { acted: false, disposition: "fatal-verification", reason: `invalid directive: ${shape.errors.join("; ")}` };
    }

    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // the structured code (with the `signature:` presentation prefix) puts it in the fatal
      // classification (§13.4 loud-failure) — an unverifiable entry in the agent's own mailbox
      // must never be silently skipped.
      return { acted: false, disposition: "fatal-verification", reason: `signature: ${(e as Error).message}` };
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
    if (!verified.ok) return { acted: false, disposition: "fatal-verification", reason: `signature: ${verified.reason}` };

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
      return { acted: false, disposition: "refused", reason: `addressee mismatch: directive.to ${directive.to} != ${self}` };
    }
    if (toAddr?.session !== undefined && toAddr.session !== this.opts.session) {
      return {
        acted: false,
        disposition: "refused",
        reason: `addressee session mismatch: ${toAddr.session} is not this invocation's current session (§13.4)`,
      };
    }

    // §9.7: reject an exact-bytes signature replay (same jti) independently of the id business-dedup.
    // FATAL, never benign — the reason text contains "already seen", but a replayed signature is a
    // verification failure; the structured code makes that precedence structural (issue #45, R4).
    if (this.seenDirectiveJti.has(sig.jti)) {
      return { acted: false, disposition: "fatal-verification", reason: "replay: jti already seen" };
    }
    // id dedup — committed (already processed) beats in-flight (a concurrent/overlapping delivery).
    if (this.seenDirectives.has(directive.id)) {
      return { acted: false, disposition: "benign-redelivery", reason: "duplicate delivery (already acted)" };
    }
    if (this.inFlightDirectives.has(directive.id)) {
      // `refused`, not benign: the overlapping first delivery has not committed yet, so nothing is
      // durably done — see `classifyEntryResult`'s concurrency note.
      return { acted: false, disposition: "refused", reason: "duplicate delivery (in flight)" };
    }

    // Commit the jti now — the same signed bytes must never be re-accepted. RESERVE the id in-flight so
    // a concurrent same-id delivery is deduped before either completes; the caller promotes it to a
    // permanent dedup via commit() after durable processing, or release()s it to allow a retry (§13.4).
    this.seenDirectiveJti.add(sig.jti);
    const id = directive.id;
    this.inFlightDirectives.add(id);
    return {
      acted: true,
      disposition: "accepted",
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
      return {
        acted: false,
        disposition: "refused",
        reason: "agent identity (agentId) not configured — cannot verify the addressee (§13.4)",
      };
    }
    const shape = validateV05("inbound-message.schema.json", message);
    if (!shape.valid) {
      // Shape validation of the Hub's own output is part of the §8.7.1 verification step: fatal.
      return { acted: false, disposition: "fatal-verification", reason: `invalid message entry: ${shape.errors.join("; ")}` };
    }

    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // the structured code (with the `signature:` presentation prefix) puts it in the fatal
      // classification (§13.4 loud-failure) — an unverifiable entry in the agent's own mailbox
      // must never be silently skipped.
      return { acted: false, disposition: "fatal-verification", reason: `signature: ${(e as Error).message}` };
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
    if (!verified.ok) return { acted: false, disposition: "fatal-verification", reason: `signature: ${verified.reason}` };

    // §13.4 amendment: the addressee check extends to the session qualifier — `to`'s principal must
    // be this agent AND, when session-qualified, the named session must be its own CURRENT session.
    const to = splitAddress(message.to);
    if (to === null || to.principal !== self) {
      return { acted: false, disposition: "refused", reason: `addressee mismatch: message.to ${message.to} != agent:${self}` };
    }
    if (to.session !== undefined && to.session !== this.opts.session) {
      return {
        acted: false,
        disposition: "refused",
        reason: `addressee session mismatch: ${to.session} is not this invocation's current session (§13.4)`,
      };
    }

    // Replay is FATAL, never benign, despite the "already seen" presentation text — the structured
    // code makes the precedence structural (issue #45, R4).
    if (this.seenDirectiveJti.has(sig.jti)) {
      return { acted: false, disposition: "fatal-verification", reason: "replay: jti already seen" };
    }

    // §13.4 amendment (MUST): an EXPLICIT deployment-declared policy gates acting on an addressed
    // ask/task — no implicit default. A notify carries no request/action surface and is exempt.
    if (message.type !== "notify") {
      const policy = this.opts.senderPolicy;
      const from = splitAddress(message.from);
      if (policy === undefined) {
        return {
          acted: false,
          disposition: "refused",
          reason: "no declared sender policy — refusing to act on an addressed ask/task (§13.4)",
        };
      }
      if (policy !== "any-same-account" && (from === null || !policy.includes(from.principal))) {
        return { acted: false, disposition: "refused", reason: `sender ${message.from} is not in the declared policy (§13.4)` };
      }
    }

    if (this.seenDirectives.has(message.id)) {
      return { acted: false, disposition: "benign-redelivery", reason: "duplicate delivery (already acted)" };
    }
    if (this.inFlightDirectives.has(message.id)) {
      // `refused`, not benign — see `classifyEntryResult`'s concurrency note.
      return { acted: false, disposition: "refused", reason: "duplicate delivery (in flight)" };
    }

    this.seenDirectiveJti.add(sig.jti);
    const id = message.id;
    this.inFlightDirectives.add(id);
    return {
      acted: true,
      disposition: "accepted",
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
      return {
        acted: false,
        disposition: "refused",
        reason: "agent identity + current session required to reconstruct the §9.8 context",
      };
    }
    // §8.7.1: a consuming agent MUST validate the delivered payload's shape before acting — the
    // sibling directive/message/receipt handlers all do. Validate against the inbound-entry UNION
    // (not the general response resource schema) so the responseEntry branch's normative `>= 0.5`
    // constraint is enforced: a mailbox response entry cannot predate v0.5 (delivery requires a
    // registered submitting session), and the resource schema would wrongly accept a 0.4 body.
    const shape = validateV05("inbound-message.schema.json", response);
    if (!shape.valid) {
      // Shape validation of the Hub's own output is part of the §8.7.1 verification step: fatal.
      return { acted: false, disposition: "fatal-verification", reason: `invalid response entry: ${shape.errors.join("; ")}` };
    }
    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // the structured code (with the `signature:` presentation prefix) puts it in the fatal
      // classification (§13.4 loud-failure) — an unverifiable entry in the agent's own mailbox
      // must never be silently skipped.
      return { acted: false, disposition: "fatal-verification", reason: `signature: ${(e as Error).message}` };
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
    if (!verified.ok) return { acted: false, disposition: "fatal-verification", reason: `signature: ${verified.reason}` };
    // Replay is FATAL, never benign — see the sibling handlers (issue #45, R4).
    if (this.seenDirectiveJti.has(sig.jti)) {
      return { acted: false, disposition: "fatal-verification", reason: "replay: jti already seen" };
    }
    this.seenDirectiveJti.add(sig.jti);

    const dedupKey = `${response.in_reply_to}::${response.resolution_id}`;
    if (this.seen.has(dedupKey)) {
      return { acted: false, disposition: "benign-redelivery", reason: "duplicate delivery (already acted)" };
    }

    let state: JsonObject | null = null;
    const sealed = response.state?.["sealed"];
    if (typeof sealed === "string") {
      try {
        state = openState(sealed, this.opts.sealKey);
      } catch (e) {
        // `refused`, not fatal (frozen behavior): the §9.8 signature verified — the recomputed
        // digest covers `state` — so an unopenable seal is an agent-side key problem, not tamper.
        return { acted: false, disposition: "refused", reason: (e as Error).message };
      }
    }
    this.seen.add(dedupKey);
    return {
      acted: true,
      disposition: "accepted",
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
      return {
        acted: false,
        disposition: "refused",
        reason: "agent identity + current session required to reconstruct the §9.8 context",
      };
    }
    const shape = validateV05("inbound-message.schema.json", receipt);
    if (!shape.valid) {
      // Shape validation of the Hub's own output is part of the §8.7.1 verification step: fatal.
      return { acted: false, disposition: "fatal-verification", reason: `invalid receipt: ${shape.errors.join("; ")}` };
    }
    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      // A malformed/missing signature header is a VERIFICATION failure, not an ordinary refusal:
      // the structured code (with the `signature:` presentation prefix) puts it in the fatal
      // classification (§13.4 loud-failure) — an unverifiable entry in the agent's own mailbox
      // must never be silently skipped.
      return { acted: false, disposition: "fatal-verification", reason: `signature: ${(e as Error).message}` };
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
    if (!verified.ok) return { acted: false, disposition: "fatal-verification", reason: `signature: ${verified.reason}` };
    // Replay is FATAL, never benign — see the sibling handlers (issue #45, R4).
    if (this.seenDirectiveJti.has(sig.jti)) {
      return { acted: false, disposition: "fatal-verification", reason: "replay: jti already seen" };
    }
    this.seenDirectiveJti.add(sig.jti);
    const dedupKey = `${receipt.in_reply_to}::${receipt.event}`;
    if (this.seenReceipts.has(dedupKey)) {
      return { acted: false, disposition: "benign-redelivery", reason: "duplicate receipt (already seen)" };
    }
    this.seenReceipts.add(dedupKey);
    return { acted: true, disposition: "accepted", receipt };
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

/**
 * The §8.7.1 ack key of one drained entry.
 *
 * Duty order (§13.4): assumes the delivered entry was already verified and dispositioned — an ack
 * is earned only AFTER durable processing (commit), or on a benign redelivery whose work already
 * durably happened. Acking an entry that failed verification, or one refused by the
 * addressee/policy checks, discards mail no duty ever authenticated or acted on.
 */
export function ackKeyOf(delivery: InboxEntryDelivery): string {
  if ("directive" in delivery) return delivery.directive.id;
  if ("message" in delivery) return delivery.message.id;
  if ("response" in delivery) return delivery.response.resolution_id;
  return delivery.receipt.id;
}
