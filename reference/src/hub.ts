// Minimal in-memory reference Hub — spec §7, §8, §9.1/§9.2, and the v0.5 inter-agent leg
// (§4 `to`, §8.7.1 entry kinds, §8.8 resolve, §14.2 delivery honesty, §16 sessions).
//
// Not a production Hub (no persistence, no real HTTP, no SSRF egress). It exists
// to demonstrate the protocol end-to-end and to host the lifecycle + signing
// behaviour the spec requires. "Push delivery" is modelled as an in-process
// `onDeliver` callback rather than an HTTP POST; the §8.7.2 SSE stream is modelled
// as `streamClaim` (a server-originated push that is deliberately NOT delivery
// evidence). Time is injected (`now`), so session leases, retention, and expiry are
// settled lazily on every touchpoint rather than by timers.

import { newDirectiveId, newJti, newMessageId, newReceiptId, newResolutionId, newSessionId } from "./ids.js";
import { applyResolution, type MessageRecord } from "./lifecycle.js";
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
} from "./signing.js";
import { validateAgainstSchema, validateMessage, validateV05, validateV05Def } from "./envelope.js";
import { MA2H_VERSION } from "./version.js";
import type {
  Ack,
  A2hMessage,
  A2hResponse,
  Actor,
  AgentAddress,
  AskMessage,
  Callback,
  Delivery,
  DestinationSnapshot,
  DirectiveFrom,
  DirectiveTo,
  InboundDelivery,
  InboundDirective,
  InboxEntryDelivery,
  InterAgentMessage,
  JsonObject,
  MailboxState,
  MailboxTrack,
  Part,
  Presence,
  PresenceState,
  Priority,
  ReceiptEntry,
  Resolution,
  ResponseDelivery,
  Session,
  SessionRegisterRequest,
  Status,
  SubmitAck,
  TaskMessage,
} from "./types.js";

/**
 * The minor at which the §9.2 signature began binding `payload_sha256` (v0.3). Push parity is anchored
 * HERE, not at IMPLEMENTED_MINOR: 0.3 and 0.4 share the payload-bound signature, so a v0.4 Hub still
 * accepts a 0.3 push (and still rejects a pre-0.3 push whose agent reconstructs the old context). Tying
 * the threshold to IMPLEMENTED_MINOR would wrongly reject 0.3 push against a 0.4 Hub (§10).
 */
const PAYLOAD_BOUND_SINCE_MINOR = 3;

export class HubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /**
     * Structured body a transport wrapper serialises alongside the status code. For an
     * `already_terminal` cancel this carries the existing `{ id, status, resolution }`
     * the §8.4 `409` MUST return, so the agent reads the real outcome without a second
     * lookup.
     */
    public readonly details?: JsonObject,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export interface DeliveredPush {
  callback: Extract<Callback, { mode: "push" }>;
  response: A2hResponse;
  /** The `MA2H-Signature` header the agent verifies. */
  signature: string;
}

export interface HubOptions {
  signingKey: string;
  baseUrl?: string;
  now?: () => number;
  onDeliver?: (push: DeliveredPush) => void;
  /** Directive-delivery visibility window (spec §8.7). Default 60s. */
  visibilityTimeoutSeconds?: number;
  /** Presence freshness window (spec §15.2) — `last_seen` older than this reads `offline`. Default 90s. */
  presenceFreshnessSeconds?: number;
  /** Session lease bounds (spec §16.1): a requested ttl is clamped INTO [min, max]. Defaults 60s / 3600s. */
  sessionMinTtlSeconds?: number;
  sessionMaxTtlSeconds?: number;
  /** Lease applied when registration requests no ttl. Default 900s (the §16.1 example). */
  sessionDefaultTtlSeconds?: number;
  /** Cap on live sessions per `agent.id` (spec §16.1); over-cap registration → 429. Default 16. */
  sessionMaxLivePerAgent?: number;
  /** How long a terminal session stays readable before purge (spec §16.3). Default 3600s. */
  sessionTerminalRetentionSeconds?: number;
  /**
   * Models `sessions.agent_list_visibility` (spec §16.4): whether same-account AGENTS may see
   * session/presence detail. When false, the §4 terminal-vs-unknown error split collapses to
   * `422 unknown_destination` and the §8.1 `destination` snapshot is `{ state: "unknown" }` for
   * agent senders — the submit path must not become a session-state oracle. Default true.
   */
  sessionVisibility?: boolean;
  /** Advertised §8.7.2 stream hold bound (`inbound.stream_max_hold_seconds`). Default 30s. */
  streamMaxHoldSeconds?: number;
  /** Message/mailbox retention (spec §8.2/§14.2), driving the v0.5 undeliverable terminals. Default 30 days. */
  retentionDays?: number;
}

/** A registered session (spec §16) plus the internal lease bookkeeping. */
interface SessionRecord {
  session: Session;
  expiresAtMs: number;
  lastSeenMs?: number;
  /** When the session reached a terminal state (purge anchor, spec §16.3). */
  terminalAtMs?: number;
}

/** A mailbox entry's payload, discriminated by the §8.7.1 entry kind. */
type EntryPayload =
  | { kind: "directive"; directive: InboundDirective }
  | { kind: "message"; message: InterAgentMessage }
  | { kind: "response"; response: A2hResponse }
  | { kind: "receipt"; receipt: ReceiptEntry };

/** An entry resting in a mailbox (spec §8.7, §13) — v0.5 generalizes the v0.4 directive record. */
type EntryRecord = EntryPayload & {
  /** The §8.7.1 ack key: directive/message `id`, response `resolution_id`, receipt `id`. */
  ackKey: string;
  /**
   * Session-addressed entries are visible ONLY to drains presenting this session (spec §8.7.1).
   * `response`/`receipt` entries always carry it (they are delivered to a specific session);
   * a principal-addressed directive/`message` omits it.
   */
  addressedSession?: string;
  /** Hidden from drains until now >= this (visibility window). 0 = immediately deliverable. */
  invisibleUntilMs: number;
  acked: boolean;
  /** First CLIENT-ORIGINATED delivery (a drain response, spec §15.1) — never a stream push. */
  deliveredAtMs?: number;
  /** A §8.7.2 stream push claimed it (visibility window started) without delivery evidence. */
  streamClaimedAtMs?: number;
  /** The session whose drain/stream last claimed it (bounce `prior:"delivered"` attribution). */
  claimedBySession?: string;
  /** Retention anchor (spec §14.2). */
  enqueuedAtMs: number;
  /** Receipt track: the ack once acknowledged. */
  ack?: Ack;
};

/** Internal mailbox track of an ADDRESSED message (spec §14.2) — survives entry compaction. */
interface MailboxTrackRecord {
  state: MailboxState;
  deliveredAtMs?: number;
  acknowledgedAtMs?: number;
  /**
   * v0.5 (§14.2): the explicit never-seen (`queued`) vs seen-then-orphaned (`delivered`) split,
   * stamped ONCE at the bounce transition from the same derivation as the bounce receipt's `prior`
   * — never re-derived at read, so the MUST-equal-receipt rule holds by construction.
   */
  prior?: "queued" | "delivered";
  ack?: Ack;
}

/** Fields a human (via the Hub) supplies to author a directive (spec §13.1). `id`/`from` are Hub-set. */
export interface SendDirectiveInput {
  /** Hub-attested author — the Hub derives this from the operator session (spec §9.1); trusted here. */
  from: DirectiveFrom;
  to: DirectiveTo;
  title: string;
  body?: string;
  priority?: Priority;
  tags?: string[];
  context?: Part[];
  expires_at?: string;
  /** Message-level sensitivity — excludes the directive's value(s) from Hub export/telemetry (§9.6). */
  sensitive?: boolean;
}

export interface ResolveInput {
  actor: Actor;
  resolution: Resolution;
  value?: string | JsonObject;
  comment?: string;
  /** Task resolutions only (v0.5, spec §6/§8.8): the final §5.3 checklist state, carried into the Response. */
  checklist?: { text: string; done: boolean }[];
}

/** `POST /v1/messages/{id}/resolve` body (spec §8.8, v0.5) — the agent-resolver wire binding. */
export interface ResolveRequestBody {
  resolution: "answered" | "declined" | "completed" | "dismissed";
  value?: string | JsonObject;
  comment?: string;
  checklist?: { text: string; done: boolean }[];
}

export type GetResult =
  | (A2hMessage & {
      id: string;
      status: Status;
      response?: A2hResponse;
      delivery?: ResponseDelivery;
      /** v0.5: the sender-authoritative outbound mailbox track (ADDRESSED messages only, §8.2). */
      mailbox?: MailboxTrack;
    })
  | null;

export class Hub {
  private readonly store = new Map<string, MessageRecord>();
  /** Per-`agent.id` mailbox of pending entries (spec §8.7, §13). FIFO = array order. */
  private readonly mailboxes = new Map<string, EntryRecord[]>();
  /** Receipt track for ask/task responses (spec §14.2), keyed by message id — response-leg states only. */
  private readonly deliveries = new Map<string, ResponseDelivery>();
  /** Receipt track for directives (spec §14.2), keyed by directive id — kept separate from `deliveries`
   * so a `/v1/inbox/ack` retry can never surface a response-leg ack (the two ack APIs stay disjoint). */
  /**
   * §14.4 directive receipt-track view. Can reach `bounced` (session-addressed directive whose
   * session goes terminal, or delivered-but-unacked past retention), so records carry the explicit
   * §14.2 `prior`, stamped at the transition beside the mailbox track's.
   */
  private readonly directiveDeliveries = new Map<string, Delivery>();
  /** Outbound mailbox track for ADDRESSED messages (spec §14.2, v0.5), keyed by message id. */
  private readonly mailboxTracks = new Map<string, MailboxTrackRecord>();
  /** `resolution_id` → message id, for the response-entry ack path (its §8.7.1 ack key). */
  private readonly responseAckIndex = new Map<string, string>();
  /** Receipt id → owning human, for the owner-only receipt read (spec §14.4). */
  private readonly deliveryOwners = new Map<string, string>();
  /** Per-`agent.id` last authenticated poll/subscription activity for presence (spec §15.1). */
  private readonly lastSeen = new Map<string, number>();
  /** Per-`agent.id` last SESSION-BEARING activity (spec §15.1 v0.5 split) — addressed reachability. */
  private readonly sessionLastSeen = new Map<string, number>();
  /** `agent.id` → owning human (spec §15.3). Presence is readable only by the owner; the same map
   * models account provisioning: a provisioned agent is a KNOWN destination (spec §4). */
  private readonly presenceOwners = new Map<string, string>();
  /** Session registry (spec §16), keyed by session id. */
  private readonly sessions = new Map<string, SessionRecord>();
  /** Per-destination sender allowlists (spec §8.0/§13.5); a block reads as unknown (spec §8.5). */
  private readonly senderAllowlists = new Map<string, Set<string>>();
  /** Accounts (by owning human) that have opted into the inter-agent leg (spec §8.0 `inter_agent.enabled`,
   * defaults false; §13.5 defense layer 1). Absent → the leg is OFF for that account. */
  private readonly interAgentOwners = new Set<string>();
  private readonly signingKey: string;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly onDeliver: ((push: DeliveredPush) => void) | undefined;
  private readonly visibilityMs: number;
  private readonly presenceFreshnessSeconds: number;
  private readonly sessionMinTtlSeconds: number;
  private readonly sessionMaxTtlSeconds: number;
  private readonly sessionDefaultTtlSeconds: number;
  private readonly sessionMaxLivePerAgent: number;
  private readonly sessionTerminalRetentionMs: number;
  private readonly sessionVisibility: boolean;
  private readonly streamMaxHoldSeconds: number;
  private readonly retentionMs: number;

  constructor(opts: HubOptions) {
    this.signingKey = opts.signingKey;
    this.baseUrl = opts.baseUrl ?? "https://hub.example";
    this.now = opts.now ?? ((): number => Date.now());
    this.onDeliver = opts.onDeliver;
    this.visibilityMs = (opts.visibilityTimeoutSeconds ?? 60) * 1000;
    this.presenceFreshnessSeconds = opts.presenceFreshnessSeconds ?? 90;
    this.sessionMinTtlSeconds = opts.sessionMinTtlSeconds ?? 60;
    this.sessionMaxTtlSeconds = opts.sessionMaxTtlSeconds ?? 3600;
    this.sessionDefaultTtlSeconds = Math.min(
      Math.max(opts.sessionDefaultTtlSeconds ?? 900, this.sessionMinTtlSeconds),
      this.sessionMaxTtlSeconds,
    );
    this.sessionMaxLivePerAgent = opts.sessionMaxLivePerAgent ?? 16;
    this.sessionTerminalRetentionMs = (opts.sessionTerminalRetentionSeconds ?? 3600) * 1000;
    this.sessionVisibility = opts.sessionVisibility ?? true;
    this.streamMaxHoldSeconds = opts.streamMaxHoldSeconds ?? 30;
    this.retentionMs = (opts.retentionDays ?? 30) * 86_400_000;
  }

  // ---- Sessions (spec §16, v0.5) ----

  /**
   * Parse an `agent:<id>[#<session>]` address by the §4 grammar: the FIRST `#` terminates the
   * agent-id segment; a session segment must match `^sess_`. Returns null for a malformed address
   * (no `agent:` scheme, empty id, or a `#` segment that is not a session) — a `#`-bearing agent id
   * is inexpressible by construction.
   */
  private static parseAddress(addr: string): { principal: string; session?: string } | null {
    if (!addr.startsWith("agent:")) return null;
    const rest = addr.slice("agent:".length);
    const hash = rest.indexOf("#");
    if (hash === -1) return rest.length > 0 ? { principal: rest } : null;
    const principal = rest.slice(0, hash);
    const session = rest.slice(hash + 1);
    if (principal.length === 0 || !session.startsWith("sess_")) return null;
    return { principal, session };
  }

  /**
   * Settle lapsed leases and purge over-retention terminal sessions (spec §16.3), against the
   * injected clock. Runs lazily at the top of every session/mailbox touchpoint — the in-memory
   * equivalent of the Hub's lease GC. A lease lapse is a terminal transition and fires the §14.2
   * bounce exactly once (first-terminal-wins: the state flip below is the CAS).
   */
  private settleSessions(nowMs: number): void {
    for (const [id, rec] of this.sessions) {
      if (rec.session.state === "active" && nowMs > rec.expiresAtMs) {
        rec.session.state = "expired";
        rec.session.closed_at = new Date(rec.expiresAtMs).toISOString();
        rec.terminalAtMs = rec.expiresAtMs;
        this.bounceSessionMail(rec, rec.expiresAtMs);
      }
      if (rec.session.state !== "active" && rec.terminalAtMs !== undefined) {
        if (nowMs > rec.terminalAtMs + this.sessionTerminalRetentionMs) this.sessions.delete(id);
      }
    }
  }

  /** Test/GC hook: settle session leases (and purge) against `now` (spec §16.3). */
  sweepSessions(nowMs?: number): void {
    this.settleSessions(nowMs ?? this.now());
  }

  /**
   * Register a session (spec §16.1): `POST /v1/sessions`. The Hub mints the `sess_` id, clamps the
   * requested ttl into the advertised bounds (the LOWER clamp keeps every lease comfortably above
   * the §8.7.2 stream hold), and caps live sessions per principal. Registration is itself
   * client-originated session-bearing activity (spec §15.1/§16.2).
   */
  registerSession(principal: string, req?: SessionRegisterRequest, nowMs?: number): { session: Session } {
    const t = nowMs ?? this.now();
    this.settleSessions(t);
    if (principal.includes("#")) {
      // §16.1: `#` is the address separator (§4 grammar) — a session such an id registered could
      // never be addressed, so registration is rejected up front.
      throw new HubError("invalid_field", `agent.id containing "#" cannot register sessions (§4/§16.1)`);
    }
    // §16.1: validate the request against `registerRequest` BEFORE clamping — otherwise a
    // non-integer `ttl_seconds` (a `NaN` reaches `toISOString()` and throws a raw RangeError) or an
    // empty `run_id` would be copied into an invalid session resource.
    if (req !== undefined) {
      const v = validateV05Def("session.schema.json", "registerRequest", req);
      if (!v.valid) throw new HubError("invalid_field", `invalid session registration: ${v.errors.join("; ")} (§16.1)`);
    }
    let live = 0;
    for (const rec of this.sessions.values()) {
      if (rec.session.agent_id === principal && rec.session.state === "active") live++;
    }
    if (live >= this.sessionMaxLivePerAgent) {
      throw new HubError("rate_limited", `live-session cap reached (${this.sessionMaxLivePerAgent}) for ${principal} (§16.1)`);
    }
    const requested = req?.ttl_seconds ?? this.sessionDefaultTtlSeconds;
    const ttl = Math.min(Math.max(requested, this.sessionMinTtlSeconds), this.sessionMaxTtlSeconds);
    const id = newSessionId();
    const session: Session = {
      id,
      agent_id: principal,
      state: "active",
      created_at: new Date(t).toISOString(),
      expires_at: new Date(t + ttl * 1000).toISOString(),
      last_seen: new Date(t).toISOString(),
      ttl_seconds: ttl,
      ...(req?.run_id !== undefined ? { run_id: req.run_id } : {}),
      ...(req?.label !== undefined ? { label: req.label } : {}),
      ...(req?.kind !== undefined ? { kind: req.kind } : {}),
      ...(req?.project !== undefined ? { project: req.project } : {}),
      ...(req?.labels !== undefined ? { labels: req.labels } : {}),
    };
    this.sessions.set(id, { session, expiresAtMs: t + ttl * 1000, lastSeenMs: t });
    this.recordSessionActivity(principal, t);
    return { session: structuredClone(session) };
  }

  /**
   * Renew a live session's lease + per-session presence from CLIENT-ORIGINATED activity that
   * references it (spec §16.2): a `?session=` drain or ack, a submit naming `agent.session`, a
   * stream (re)connect. A merely-open connection never reaches here (§8.7.2).
   */
  private renewSession(rec: SessionRecord, nowMs: number): void {
    if (rec.session.state !== "active") return;
    const ttl = (rec.session.ttl_seconds ?? this.sessionDefaultTtlSeconds) * 1000;
    rec.expiresAtMs = nowMs + ttl;
    rec.session.expires_at = new Date(rec.expiresAtMs).toISOString();
    rec.lastSeenMs = nowMs;
    rec.session.last_seen = new Date(nowMs).toISOString();
    this.recordSessionActivity(rec.session.agent_id, nowMs);
  }

  /** Record per-`agent.id` SESSION-BEARING activity (the §15.1 v0.5 derivation split). */
  private recordSessionActivity(principal: string, nowMs: number): void {
    this.sessionLastSeen.set(principal, nowMs);
    this.lastSeen.set(principal, nowMs); // session-bearing activity is authenticated activity too
  }

  /**
   * Resolve a caller-presented `?session=` under the §8.7.1 drain rules: the caller's own LIVE
   * session, else foreign/unknown → `404 not_found` (indistinguishable, §9.1) and own-but-terminal
   * → `410` — distinct by design, and the 410 itself splits by WHO terminated the session (§16.3):
   * `gone` for expired/self-closed, so a bridge returning from a lease lapse learns "re-register
   * and continue" instead of treating its own address as nonexistent (§16); the §16.4 operator
   * kill-switch instead reads `session_closed_by_operator` — "stop; do not re-register" — so the
   * killed party never re-registers straight through the kill it was just dealt.
   * On success the presentation renews the lease (client-originated activity).
   */
  /**
   * The §16.4 kill-switch marker as a wire error: thrown ahead of each touchpoint's own terminal
   * fallback (`gone` at presentation touchpoints, `destination_gone` at the own-session submit),
   * so the split stays identical at every §16.3 row that emits it.
   */
  private static operatorClosedError(label: string, sessionId: string): HubError {
    return new HubError(
      "session_closed_by_operator",
      `${label} ${sessionId} was closed by the account's operator — stop; do not re-register (§16.4)`,
    );
  }

  private presentSession(principal: string, sessionId: string, nowMs: number): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.session.agent_id !== principal) {
      throw new HubError("not_found", `unknown session: ${sessionId}`);
    }
    if (rec.session.state !== "active") {
      if (rec.session.closed_by_operator === true) {
        throw Hub.operatorClosedError("session", sessionId);
      }
      throw new HubError("gone", `session ${sessionId} is ${rec.session.state} — re-register and continue (§16.3)`);
    }
    this.renewSession(rec, nowMs);
    return rec;
  }

  /**
   * Close a session (spec §16.3/§16.4): `DELETE /v1/sessions/{id}`. Owner-only, with ONE exception:
   * the account's authenticated human may close any account session — the attested operator
   * KILL-SWITCH, whose §14.2 bounce unblocks senders waiting on a wedged addressee (§9.1). An
   * operator close is MARKED on the session resource (`closed_by_operator: true`, §16.4) —
   * true-only emission, never `false`, and only on the WINNING terminal transition: the settle
   * above means a lapsed lease that already won the CAS stays plain `expired`, never retroactively
   * marked (§16.3). Idempotent: re-closing a terminal session returns it unchanged
   * (first-terminal-wins). A caller that neither owns the session nor the account sees `404`
   * (indistinguishable from unknown).
   */
  closeSession(sessionId: string, caller: string, nowMs?: number): { session: Session } {
    const t = nowMs ?? this.now();
    this.settleSessions(t);
    const rec = this.sessions.get(sessionId);
    const isOwner = rec !== undefined && rec.session.agent_id === caller;
    const isAccountHuman = rec !== undefined && this.isAccountHuman(rec.session.agent_id, caller);
    if (!rec || (!isOwner && !isAccountHuman)) {
      throw new HubError("not_found", `unknown session: ${sessionId}`);
    }
    if (rec.session.state === "active") {
      rec.session.state = "closed";
      rec.session.closed_at = new Date(t).toISOString();
      // §16.4: the closer was the account's human, NOT the owning principal — the kill-switch
      // exception path. Recorded here (and only here — this branch IS the winning CAS) so the
      // marker can never appear on an expired or self-closed session.
      if (isAccountHuman && !isOwner) rec.session.closed_by_operator = true;
      rec.terminalAtMs = t;
      this.bounceSessionMail(rec, t);
    }
    return { session: structuredClone(rec.session) };
  }

  /**
   * Read one session (spec §15.3/§16.4): the owning principal always; the account's human always;
   * anyone else sees `404` (another principal's session id is indistinguishable from unknown).
   */
  getSession(sessionId: string, caller: string, nowMs?: number): { session: Session } {
    const t = nowMs ?? this.now();
    this.settleSessions(t);
    const rec = this.sessions.get(sessionId);
    const permitted =
      rec !== undefined &&
      (rec.session.agent_id === caller || this.isAccountHuman(rec.session.agent_id, caller));
    if (!rec || !permitted) throw new HubError("not_found", `unknown session: ${sessionId}`);
    return { session: structuredClone(rec.session) };
  }

  /**
   * List the caller's OWN sessions (live and recent-terminal) — unconditional, independent of any
   * visibility policy (spec §16.4): a restarted or crash-looping agent MUST be able to find, close,
   * or let-lapse its stale leases before hitting the live-session cap.
   */
  listSessions(principal: string, nowMs?: number): { sessions: Session[] } {
    const t = nowMs ?? this.now();
    this.settleSessions(t);
    const out: Session[] = [];
    for (const rec of this.sessions.values()) {
      if (rec.session.agent_id === principal) out.push(structuredClone(rec.session));
    }
    return { sessions: out };
  }

  /** The §8.7.2 stream hold bound for a session: the LESSER of the advertised hold and a point a
   * nonzero margin before lease expiry, so a healthy client is always handed its reconnect-renewal
   * while the lease can still be renewed (the zombie-socket rule). Returns milliseconds from `now`. */
  streamHoldBoundMs(sessionId: string, principal: string, nowMs?: number): number {
    const t = nowMs ?? this.now();
    this.settleSessions(t);
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.session.agent_id !== principal) throw new HubError("not_found", `unknown session: ${sessionId}`);
    if (rec.session.state !== "active") {
      // A stream connect is an own-session presentation touchpoint (§8.7.2), so its 410 carries the
      // same §16.3 split as presentSession: operator kill → the marker code, else plain `gone`.
      if (rec.session.closed_by_operator === true) {
        throw Hub.operatorClosedError("session", sessionId);
      }
      throw new HubError("gone", `session ${sessionId} is ${rec.session.state}`);
    }
    const advertised = this.streamMaxHoldSeconds * 1000;
    // Implementation-defined nonzero margin (spec §8.7.2): a quarter of the lease, capped at 5s —
    // closing exactly AT expiry would hand the client a renewal moment it can only use after the
    // lease is already immutably terminal.
    const untilExpiry = rec.expiresAtMs - t;
    const margin = Math.min(Math.max(Math.floor(untilExpiry / 4), 1), 5000);
    return Math.max(Math.min(advertised, untilExpiry - margin), 0);
  }

  /**
   * Version negotiation (§10) — runs before schema validation so an unknown major returns
   * `version_not_supported`, not a generic `validation_error`.
   *
   * - Rejects an unrecognized **major** (this Hub implements major 0).
   * - Rejects a **pre-0.3 push** request: every pushed Response is signed with the v0.3
   *   payload-bound `signed_context` (§9.2), which a pre-0.3 agent reconstructs differently and
   *   rejects, so a v0.3 Hub's push is only verifiable by a v0.3+ agent. **Pull is unaffected** —
   *   pull responses aren't signature-verified (§8.2) — so a pre-0.3 *pull* message is accepted.
   *
   * A malformed `ma2h_version` falls through to schema validation (a `validation_error`).
   */
  private negotiateVersion(message: A2hMessage): void {
    // A non-object body (`null`, array, primitive) must reach schema validation and yield a
    // `validation_error` — never a raw TypeError here. (`typeof null === "object"`, so guard null too.)
    if (typeof message !== "object" || message === null) return;
    const raw = (message as { ma2h_version?: unknown }).ma2h_version;
    if (typeof raw !== "string") return;

    // Only a version matching the schema's recognized SHAPE is negotiated here; anything else (leading
    // zeros, extra parts) is a malformed envelope and MUST fall through to schema validation — a
    // consistent `validation_error`, independent of callback mode. The schema is `^0\.\d+$`, and §10
    // reads the major as the integer before the first dot.
    //
    // §10 — a canonical non-zero major is recognized-but-unsupported (this Hub implements major 0):
    const nonZeroMajor = /^([1-9]\d*)\.\d+$/.exec(raw);
    if (nonZeroMajor) {
      throw new HubError(
        "version_not_supported",
        `ma2h_version "${raw}": major ${nonZeroMajor[1]} is not supported (this Hub implements ${MA2H_VERSION}; §10)`,
      );
    }
    // Push parity (§9.2 v0.3 break) — a `0.x` with a CANONICAL minor (no leading zeros) below the
    // payload-bound minor whose callback is push. Anchored at PAYLOAD_BOUND_SINCE_MINOR (3), NOT the
    // implemented minor — else a 0.4 Hub would wrongly reject a 0.3 push, which shares the same
    // payload-bound signature and stays compatible. A NON-canonical minor (e.g. `0.03`) matches
    // neither this nor `nonZeroMajor`, so it falls through to schema validation — which now rejects it
    // (`^0\.(0|[1-9]\d*)$`) as a `validation_error` rather than treating `0.03` as minor 3 and letting
    // a push slip past the parity gate.
    const zeroX = /^0\.(0|[1-9]\d*)$/.exec(raw);
    if (zeroX && Number(zeroX[1]) < PAYLOAD_BOUND_SINCE_MINOR && this.callbackOf(message)?.mode === "push") {
      throw new HubError(
        "version_not_supported",
        `ma2h_version "${raw}": push callbacks require >= 0.${PAYLOAD_BOUND_SINCE_MINOR}. The pushed Response is signed ` +
          `with the v0.3 payload-bound signature (§9.2), which a pre-0.3 agent cannot verify. Use a pull callback, or upgrade.`,
      );
    }
  }

  /** The envelope's minor version, when its `ma2h_version` has the canonical `0.x` shape. */
  private static minorOf(message: A2hMessage): number | null {
    // Guard a non-object body (`null`, array, primitive): it must reach schema validation and
    // yield a `validation_error`, never a raw TypeError here (as negotiateVersion).
    if (typeof message !== "object" || message === null) return null;
    const raw = (message as { ma2h_version?: unknown }).ma2h_version;
    if (typeof raw !== "string") return null;
    const m = /^0\.(0|[1-9]\d*)$/.exec(raw);
    return m ? Number(m[1]) : null;
  }

  submit(message: A2hMessage, nowMs?: number): SubmitAck {
    const t = nowMs ?? this.now();
    this.settleSessions(t);
    this.negotiateVersion(message);

    // Sender-side symmetry (§4): an addressed or session-bearing submit from a `#`-bearing
    // principal is rejected `422 invalid_field` — the Hub could not attest a `from` the first-`#`
    // grammar represents. Checked BEFORE schema validation (guarded reads: a malformed body falls
    // through to the `validation_error` below) so the spec-pinned 422 surfaces rather than the
    // v0.5 schema's own belt-and-braces encoding of the same rule (a 400).
    if (typeof message === "object" && message !== null) {
      const probe = message as { to?: unknown; agent?: { id?: unknown; session?: unknown } };
      const participates = probe.to !== undefined || probe.agent?.session !== undefined;
      if (participates && typeof probe.agent?.id === "string" && probe.agent.id.includes("#")) {
        throw new HubError("invalid_field", `agent.id containing "#" cannot participate in the inter-agent leg (§4)`);
      }
    }

    // Version-aware validation (§10): a >= 0.5 envelope validates against the v0.5 schema snapshot
    // (which knows `to`/`agent.session`); anything else keeps the v0.4 registry byte-identically.
    const minor = Hub.minorOf(message);
    const v =
      minor !== null && minor >= 5 ? validateV05("message.schema.json", message) : validateMessage(message);
    if (!v.valid) throw new HubError("validation_error", `invalid message: ${v.errors.join("; ")}`);

    // v0.5 field discipline: `to`/`agent.session` are v0.5 semantics. This Hub KNOWS the fields, so
    // silently misrouting a pre-0.5 envelope that carries them to the human inbox (what a genuinely
    // pre-0.5 Hub does, §8.1) would be a live false belief — reject instead.
    if ((message.to !== undefined || message.agent.session !== undefined) && (minor === null || minor < 5)) {
      throw new HubError(
        "invalid_field",
        `\`to\`/\`agent.session\` are v0.5 fields; ma2h_version ${message.ma2h_version} predates them (§4, §10)`,
      );
    }

    // §4: `expires_at` MUST be in the future at submit or the Hub rejects `422 invalid_field`
    // (§8.5). Accepting a corpse with a success ack — acked `open`/`queued` with a reachability
    // snapshot implying deliverability, then auto-expiring on the first mailbox touch — is the
    // accept-then-dead-letter false belief the delivery-honesty rules exist to kill (mirrors the
    // §13.1 directive check). Applies to every verb, addressed or not.
    if (message.expires_at !== undefined && Date.parse(message.expires_at) <= t) {
      throw new HubError("invalid_field", `expires_at ${message.expires_at} is not in the future (§4/§8.5)`);
    }

    // `agent.session` (§4.1): must name one of the authenticated principal's OWN sessions —
    // foreign/unknown → 422; own-but-terminal → 410. Naming it is client-originated renewal (§16.2).
    let submitterSession: SessionRecord | undefined;
    if (message.agent.session !== undefined) {
      const rec = this.sessions.get(message.agent.session);
      if (!rec || rec.session.agent_id !== message.agent.id) {
        throw new HubError("invalid_field", `agent.session ${message.agent.session} is not a session of ${message.agent.id} (§4.1)`);
      }
      if (rec.session.state !== "active") {
        // §16.3: the own-session submit splits by WHO terminated it — the §16.4 kill-switch reads
        // the marker code; every OTHER terminal keeps the existing `destination_gone` wire contract
        // (this touchpoint never emitted `gone`, and moving it would be a wire change).
        if (rec.session.closed_by_operator === true) {
          throw Hub.operatorClosedError("agent.session", message.agent.session);
        }
        throw new HubError("destination_gone", `agent.session ${message.agent.session} is ${rec.session.state} (§4.1)`);
      }
      this.renewSession(rec, t);
      submitterSession = rec;
    }

    const id = newMessageId();
    const isNotify = message.type === "notify";

    if (message.to !== undefined) {
      return this.submitAddressed(message, id, t, submitterSession);
    }

    const record: MessageRecord = {
      id,
      message,
      status: isNotify ? "delivered" : "open",
      createdAtMs: t,
      expiresAtMs: message.expires_at ? Date.parse(message.expires_at) : null,
      resolution_id: null,
      response: null,
    };
    this.store.set(id, record);
    return {
      id,
      status: isNotify ? "delivered" : "open",
      poll_url: `${this.baseUrl}/v1/messages/${id}`,
      review_url: `${this.baseUrl}/inbox/${id}`,
    };
  }

  /**
   * Submit-time destination validation + routing for a `to`-carrying envelope (spec §4, §8.1).
   * Accepting an unroutable destination and silently dead-lettering the message is exactly the
   * false-belief failure the v0.5 delivery-honesty rules exist to kill (§14).
   */
  private submitAddressed(
    message: A2hMessage,
    id: string,
    t: number,
    submitterSession: SessionRecord | undefined,
  ): SubmitAck {
    // §8.0/§13.5 layer 1: the inter-agent leg is account-opt-in and defaults OFF. A Hub MUST NOT
    // accept `to`-addressed submits from an account that has not opted in. This is the submitter's
    // OWN account state (not the destination's), so rejecting is not an existence oracle.
    const submitterOwner = this.presenceOwners.get(message.agent.id);
    if (submitterOwner === undefined || !this.interAgentOwners.has(submitterOwner)) {
      throw new HubError("not_authorized", `the inter-agent leg is not enabled for this account (§8.0 inter_agent.enabled)`);
    }
    const dest = this.validateDestination(message.to as string, message.agent.id);

    // Delivered form (§8.7.1): the submitted envelope plus Hub-assigned `id` and Hub-attested
    // `from` (session-qualified when the submit carried `agent.session`), with submitter-side
    // machinery STRIPPED: `state` (round-tripped only in the §6 Response), `client_ref` (§9.1
    // forbids exposing it to resolvers), and any callback (the submitter's delivery config).
    // `idempotency_key` is delivered (inert to the addressee).
    const from: AgentAddress =
      submitterSession !== undefined
        ? (`agent:${message.agent.id}#${submitterSession.session.id}` as AgentAddress)
        : (`agent:${message.agent.id}` as AgentAddress);
    const delivered = structuredClone(message) as InterAgentMessage;
    delivered.id = id;
    delivered.from = from;
    delivered.to = message.to as AgentAddress;
    delete (delivered as { state?: unknown }).state;
    delete (delivered as { client_ref?: unknown }).client_ref;
    if (delivered.type === "ask") delete (delivered.request as { callback?: unknown }).callback;
    if (delivered.type === "task") delete (delivered.action as { callback?: unknown }).callback;
    const shape = validateV05("inbound-message.schema.json", delivered);
    if (!shape.valid) {
      throw new HubError("validation_error", `delivered form invalid: ${shape.errors.join("; ")}`);
    }

    const isNotify = message.type === "notify";
    const record: MessageRecord = {
      id,
      message,
      // An addressed notify's lifecycle IS the §14.2 mailbox track (§5.1): `queued`, never
      // `delivered`, at accept. Addressed ask/task keep the §7 `open` (it asserts nothing about
      // delivery and was never the lie).
      status: isNotify ? "queued" : "open",
      createdAtMs: t,
      expiresAtMs: message.expires_at ? Date.parse(message.expires_at) : null,
      resolution_id: null,
      response: null,
    };
    this.store.set(id, record);
    this.mailboxTracks.set(id, { state: "queued" });

    const box = this.mailboxes.get(dest.principal) ?? [];
    box.push({
      kind: "message",
      message: delivered,
      ackKey: id,
      ...(dest.session !== undefined ? { addressedSession: dest.session } : {}),
      invisibleUntilMs: 0,
      acked: false,
      enqueuedAtMs: t,
    });
    this.mailboxes.set(dest.principal, box);

    return {
      id,
      status: isNotify ? "queued" : "open",
      poll_url: `${this.baseUrl}/v1/messages/${id}`,
      review_url: `${this.baseUrl}/inbox/${id}`,
      // The REQUIRED reachability snapshot — also the sender's misroute detector (§8.1).
      destination: this.destinationSnapshot(dest.principal, dest.session, t, message.agent.id),
    };
  }

  /**
   * Validate a destination address within the submitter's account (spec §4): unknown principal
   * (or cross-account, indistinguishably), unknown session, or an allowlist block → `422
   * unknown_destination`; an own-account TERMINAL session → `410 destination_gone` — collapsed to
   * `422` for a sender the visibility policy denies (the error split must not become a
   * session-state oracle).
   */
  private validateDestination(to: string, submitter: string): { principal: string; session?: string } {
    const parsed = Hub.parseAddress(to);
    if (!parsed) throw new HubError("validation_error", `malformed destination: ${to} (§4 grammar)`);
    const destOwner = this.presenceOwners.get(parsed.principal);
    const sameAccount = destOwner !== undefined && destOwner === this.presenceOwners.get(submitter);
    if (!sameAccount) {
      // Unknown and cross-account are indistinguishable — no existence oracle (§4).
      throw new HubError("unknown_destination", `unknown destination: ${to} (§4)`);
    }
    const allowlist = this.senderAllowlists.get(parsed.principal);
    if (allowlist !== undefined && !allowlist.has(submitter)) {
      // A policy block MUST be indistinguishable from a nonexistent destination (§8.5, §13.5).
      throw new HubError("unknown_destination", `unknown destination: ${to} (§4)`);
    }
    if (parsed.session !== undefined) {
      const rec = this.sessions.get(parsed.session);
      if (!rec || rec.session.agent_id !== parsed.principal) {
        throw new HubError("unknown_destination", `unknown destination: ${to} (§4)`);
      }
      if (rec.session.state !== "active") {
        // Own-session visibility is UNCONDITIONAL (§16.4): a principal addressing one of its OWN
        // sessions (the documented shared-credential fleet mode) always sees the honest 410 split —
        // it never lacks visibility for itself. The oracle-guard collapse applies only to a
        // third-party sender the policy denies.
        if (!this.sessionVisibility && parsed.principal !== submitter) {
          throw new HubError("unknown_destination", `unknown destination: ${to} (§4)`);
        }
        throw new HubError("destination_gone", `destination session ${parsed.session} is ${rec.session.state} (§4, §8.5)`);
      }
    }
    return parsed;
  }

  /**
   * The destination's reachability at send time (spec §8.1), derived per the §15.1 v0.5 split from
   * SESSION-BEARING activity only: `online` requires a LIVE session with fresh session-bearing
   * `last_seen` — a destination whose only consumer drains session-less MUST NOT read `online`
   * (it can never be shown a v0.5 entry). Exactly `{ state: "unknown" }` when the sender lacks
   * visibility (§16.4 policy) or the destination has no session history.
   */
  private destinationSnapshot(
    principal: string,
    sessionId: string | undefined,
    nowMs: number,
    submitter: string,
  ): DestinationSnapshot {
    // §16.4: own-session/own-principal visibility is unconditional — a sender addressing itself
    // always gets the honest snapshot; the policy blanks it only for a third-party destination.
    if (!this.sessionVisibility && principal !== submitter) return { state: "unknown" };
    if (sessionId !== undefined) {
      const rec = this.sessions.get(sessionId);
      const seen = rec?.lastSeenMs;
      if (rec === undefined || seen === undefined) return { state: "unknown" };
      const fresh = nowMs - seen <= this.presenceFreshnessSeconds * 1000;
      const state: PresenceState = rec.session.state === "active" && fresh ? "online" : "offline";
      return { state, last_seen: new Date(seen).toISOString() };
    }
    const seen = this.sessionLastSeen.get(principal);
    if (seen === undefined) return { state: "unknown" };
    let liveExists = false;
    for (const rec of this.sessions.values()) {
      if (rec.session.agent_id === principal && rec.session.state === "active") {
        liveExists = true;
        break;
      }
    }
    const fresh = nowMs - seen <= this.presenceFreshnessSeconds * 1000;
    return { state: liveExists && fresh ? "online" : "offline", last_seen: new Date(seen).toISOString() };
  }

  /**
   * Configure a per-destination sender allowlist (spec §8.0 `sender_allowlists`, §13.5): when set,
   * only the listed submitter principals may address `agentId`; a blocked submit collapses to
   * `422 unknown_destination` (§8.5). Passing null clears the list (back to account-wide default).
   */
  setSenderAllowlist(agentId: string, allowed: string[] | null): void {
    if (allowed === null) this.senderAllowlists.delete(agentId);
    else this.senderAllowlists.set(agentId, new Set(allowed));
  }

  /**
   * Poll a message (§8.2). `principal` is the authenticated caller's `agent.id` and is
   * REQUIRED: there is no unauthenticated poll in the protocol, so the submitter-binding
   * (§9.1) cannot be bypassed by omitting it. To a non-submitting principal the message is
   * invisible (`null`), indistinguishable from an unknown id — the same id-enumeration guard
   * `cancel()` applies. The Hub reads its own internal state directly off `store`, never here.
   */
  get(id: string, principal: string): GetResult {
    const t = this.now();
    this.settleSessions(t);
    // An authenticated poll is presence activity (§15.1) even when the id is unknown/foreign.
    this.recordActivity(principal, t);
    const r = this.store.get(id);
    if (!r) return null;
    if (r.message.agent.id !== principal) return null;
    // Receipt track (§14.2): the submitting agent reading its resolved message counts as
    // `delivered-to-agent` (the pull equivalent of a push 2xx), unless it was already acknowledged.
    if (r.status !== "open" && r.message.type !== "notify") this.markDeliveredToAgent(id, t);
    const delivery = this.deliveries.get(id);
    const track = this.mailboxTracks.get(id);
    return {
      ...r.message,
      id: r.id,
      status: r.status,
      ...(r.response ? { response: r.response } : {}),
      // Clone the delivery so a caller mutating `got.delivery` can't corrupt the stored receipt track.
      ...(delivery ? { delivery: structuredClone(delivery) } : {}),
      // v0.5 (§8.2): the sender's AUTHORITATIVE outbound mailbox track — addressed messages only.
      // On `bounced` it carries the explicit `prior` stamped at the transition, equal to the bounce
      // receipt's (§14.2); `delivered_at`-presence stays the legacy inference `prior` supersedes.
      ...(track ? { mailbox: Hub.publicMailboxTrack(track) } : {}),
    };
  }

  /** Project the internal mailbox track to its §8.2 wire shape. */
  private static publicMailboxTrack(track: MailboxTrackRecord): MailboxTrack {
    return {
      state: track.state,
      ...(track.deliveredAtMs !== undefined ? { delivered_at: new Date(track.deliveredAtMs).toISOString() } : {}),
      ...(track.acknowledgedAtMs !== undefined
        ? { acknowledged_at: new Date(track.acknowledgedAtMs).toISOString() }
        : {}),
      // v0.5 (§14.2): the stored bounce-transition stamp — present only on a `bounced` terminal.
      ...(track.prior !== undefined ? { prior: track.prior } : {}),
    };
  }

  /**
   * Agent-initiated withdrawal of an open `ask` (§8.4). Submitter-bound per §9.1:
   * `principal` is the authenticated caller's `agent.id`. A caller that did not
   * submit the message cannot learn it exists — a foreign id and an unknown id are
   * indistinguishable (`not_found`), which makes the binding an id-enumeration guard
   * and stops one agent from terminally withdrawing another's open ask. On success
   * the `cancelled` Response is emitted and delivered like a resolve (push and/or
   * pull), so the agent still gets closure. A cancel past `expires_at` loses to the
   * default expiry (§7); a cancel after any *other* terminal throws `already_terminal`
   * carrying the existing `{ id, status, resolution }` (§8.4 `409`).
   */
  cancel(id: string, principal: string, nowMs?: number): A2hResponse {
    // Settle session leases first (§7/§16.3): a session-addressed ask whose destination lease
    // already elapsed must let its `system:undeliverable` bounce win the CAS over a late cancel,
    // exactly as resolve() — the same "applies a terminal without touching a session" path.
    this.settleSessions(nowMs ?? this.now());
    const record = this.store.get(id);
    if (!record || record.message.agent.id !== principal) {
      throw new HubError("not_found", `unknown message: ${id}`);
    }
    if (record.message.type !== "ask") {
      throw new HubError("validation_error", "only an `ask` is cancellable in v0.3");
    }
    const t = nowMs ?? this.now();
    // Expiry-vs-cancel (§7): the ask conceptually expired at `expires_at`. A cancel arriving
    // strictly after that loses to the default expiry against the same clock — exactly as a
    // late resolve does (see `resolve`) — so an overdue ask resolves to `expired`/
    // `default_on_expire`, never `cancelled`. Guarded on `open` so it never re-fires a
    // terminal: an already-`cancelled` ask still re-cancels idempotently below.
    if (record.status === "open" && record.expiresAtMs !== null && t > record.expiresAtMs) {
      return this.applyDefaultExpiry(record, t);
    }
    if (record.status !== "open") {
      // first-terminal-wins (§7): a prior terminal stands. A repeat cancel is idempotent;
      // any other terminal is surfaced — with the existing `{ id, status, resolution }` the
      // §8.4 `409` MUST carry — so the agent reads the real outcome, not a fake success.
      if (record.status !== "cancelled") {
        const existing = record.response as A2hResponse;
        throw new HubError("already_terminal", `message already ${record.status}`, {
          id: record.id,
          status: record.status,
          resolution: existing.resolution,
        });
      }
      return record.response as A2hResponse;
    }
    applyResolution(record, {
      resolution: "cancelled",
      actor: `agent:${record.message.agent.id}`,
      resolved_at: new Date(t).toISOString(),
      resolution_id: newResolutionId(),
      ...(record.message.state !== undefined ? { state: record.message.state } : {}),
    });
    this.emitResponse(record);
    return record.response as A2hResponse;
  }

  /** Human/inbox resolution. Enforces fail-closed authz + expiry-vs-answer precedence. */
  resolve(id: string, input: ResolveInput, nowMs?: number): A2hResponse {
    const t = nowMs ?? this.now();
    // Settle session leases FIRST (§7/§16.3): a session-addressed ask/task that lists a human
    // resolver but whose destination lease already elapsed must have its `system:undeliverable`
    // bounce win the first-terminal CAS — a human answer applied before the settle would wrongly
    // stand (a later sweep cannot replace a terminal Response). Every session touchpoint settles;
    // this human-facing path is the one that could apply a terminal without touching a session.
    this.settleSessions(t);
    const record = this.store.get(id);
    if (!record) throw new HubError("not_found", `unknown message: ${id}`);
    if (record.message.type === "notify") {
      throw new HubError("validation_error", "notify is not resolvable");
    }
    if (record.status !== "open") return record.response as A2hResponse; // first-terminal-wins

    this.assertAuthorized(record.message, input.actor);

    // expiry-vs-answer: an answer strictly after expires_at loses to the default.
    if (record.expiresAtMs !== null && t > record.expiresAtMs) {
      return this.applyDefaultExpiry(record, t);
    }

    const res = applyResolution(record, {
      resolution: input.resolution,
      actor: input.actor,
      resolved_at: new Date(t).toISOString(),
      resolution_id: newResolutionId(),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      // Checklists are TASK-only (§6): the v0.5 response schema forbids one on an ask Response, and
      // a mailbox consumer rejects a Hub-signed response that carries it — so gate on the verb
      // rather than trusting an undiscriminated ResolveInput.
      ...(input.checklist !== undefined && record.message.type === "task" ? { checklist: input.checklist } : {}),
      ...(record.message.state !== undefined ? { state: record.message.state } : {}),
    });
    if (res.applied) this.emitResponse(record);
    return record.response as A2hResponse;
  }

  /** Expiry sweep for one message. Returns the Response if it expired now, else null. */
  expire(id: string, nowMs?: number): A2hResponse | null {
    const t = nowMs ?? this.now();
    // Settle session leases first (§7/§16.3), as resolve()/cancel(): if a session-addressed ask's
    // destination lease lapsed BEFORE its message-level expires_at, the `system:undeliverable`
    // bounce is the earlier terminal and must win the CAS — an explicit expire() applied first
    // would wrongly stamp `expired` (a later sweep cannot replace a terminal Response).
    this.settleSessions(t);
    const record = this.store.get(id);
    if (!record) return null;
    if (record.status !== "open") return record.response;
    if (record.expiresAtMs === null || t <= record.expiresAtMs) return null;
    return this.applyDefaultExpiry(record, t);
  }

  private applyDefaultExpiry(record: MessageRecord, nowMs: number): A2hResponse {
    if (record.status !== "open") return record.response as A2hResponse;
    const dflt =
      record.message.type === "ask" ? record.message.request.default_on_expire : undefined;
    applyResolution(record, {
      resolution: "expired",
      actor: "system:default_on_expire",
      defaulted: true,
      resolved_at: new Date(nowMs).toISOString(),
      resolution_id: newResolutionId(),
      ...(dflt !== undefined && dflt !== null ? { value: dflt } : {}),
      ...(record.message.state !== undefined ? { state: record.message.state } : {}),
    });
    this.emitResponse(record);
    return record.response as A2hResponse;
  }

  /**
   * Match one `allowed_resolvers` entry against a Hub-attested actor (spec §9.1, v0.5 rules):
   * a PRINCIPAL-form agent entry (`agent:<id>`) matches that principal under ANY session (the
   * actor's session qualifier is ignored); a SESSION-qualified entry (`agent:<id>#<session>`)
   * matches only that exact session; `human:`/`system:` entries match exactly. An entry whose `#`
   * segment is not a session (a legacy `#`-bearing id) falls back to exact-literal matching.
   */
  private static resolverEntryMatches(entry: Actor, actor: Actor): boolean {
    if (entry === actor) return true;
    if (!entry.startsWith("agent:") || !actor.startsWith("agent:")) return false;
    const entryAddr = Hub.parseAddress(entry);
    const actorAddr = Hub.parseAddress(actor);
    if (!entryAddr || !actorAddr) return false;
    if (entryAddr.session !== undefined) return false; // exact session match already handled above
    return entryAddr.principal === actorAddr.principal;
  }

  /**
   * Resolver authorization (spec §9.1). Fail-closed defaults: for an UNADDRESSED message only the
   * submitting principal's own identity (any of its sessions) may resolve; for an ADDRESSED
   * (`to`-carrying) message the default flips to the ADDRESSEE principal (any of its sessions) —
   * the submitter of an ask is the one party who must NOT answer it, and the account's human is
   * deliberately NOT a default resolver for agent-addressed messages (the operator's unstick
   * recourse is the §16 session kill-switch).
   */
  private assertAuthorized(message: AskMessage | TaskMessage, actor: Actor): void {
    const allowed =
      message.type === "ask" ? message.request.allowed_resolvers : message.action.allowed_resolvers;
    let permitted: boolean;
    if (allowed) {
      permitted = allowed.some((entry) => Hub.resolverEntryMatches(entry, actor));
    } else {
      const defaultPrincipal =
        message.to !== undefined ? Hub.parseAddress(message.to)?.principal : message.agent.id;
      const actorAddr = actor.startsWith("agent:") ? Hub.parseAddress(actor) : null;
      permitted = actorAddr !== null && defaultPrincipal !== undefined && actorAddr.principal === defaultPrincipal;
    }
    if (!permitted) {
      throw new HubError("not_authorized", `resolver ${actor} is not permitted for this message`);
    }
  }

  /**
   * The §8.8 resolve binding: `POST /v1/messages/{id}/resolve` with an AGENT credential — the wire
   * surface the inter-agent leg's addressee resolves through (spec §6). `principal` is the
   * authenticated caller's `agent.id`; `opts.session` is the `?session=` presentation, validated
   * under exactly the §8.7.1 drain rules (own live → renewal + session-qualified attested actor;
   * foreign/unknown → 404; own-terminal → 410). Validation: body shape against
   * `resolve-request.schema.json`, then verb-match and value-vs-request (`422 invalid_field`), then
   * §9.1 authorization, then the §7 atomic CAS — a resolve after a terminal returns
   * `409 already_terminal` carrying the existing `{ id, status, resolution }`, and a resolve after
   * `expires_at` loses to the default expiry evaluated on the same clock.
   */
  resolveAsAgent(
    id: string,
    principal: string,
    body: ResolveRequestBody,
    opts?: { session?: string; now?: number },
  ): { id: string; status: Status; resolution_id: string; response: A2hResponse } {
    const t = opts?.now ?? this.now();
    this.settleSessions(t);
    // Sender-side symmetry on the RESOLVE end (§4): a `#`-bearing principal cannot participate in
    // the inter-agent leg on ANY end. Without this, `agent:${principal}` naive-concats the `#`, and
    // assertAuthorized round-trips the actor back through the first-`#` parser — truncating a
    // cross-account `victim#sess_evil` to `victim` and forging the addressee's decision. Rejected
    // here exactly as submit() and registerSession() reject it.
    if (principal.includes("#")) {
      throw new HubError("invalid_field", `agent.id containing "#" cannot participate in the inter-agent leg (§4)`);
    }
    let actor: Actor = `agent:${principal}`;
    if (opts?.session !== undefined) {
      this.presentSession(principal, opts.session, t);
      actor = `agent:${principal}#${opts.session}`;
    }
    const record = this.store.get(id);
    if (!record) throw new HubError("not_found", `unknown message: ${id}`);
    if (record.message.type === "notify") {
      throw new HubError("validation_error", "notify is not resolvable");
    }
    const bv = validateV05("resolve-request.schema.json", body);
    if (!bv.valid) throw new HubError("validation_error", `invalid resolve request: ${bv.errors.join("; ")}`);
    this.assertAuthorized(record.message, actor);
    // Verb-match (§8.8): answered/declined are ask terminals, completed/dismissed task terminals.
    const isAsk = record.message.type === "ask";
    const askResolution = body.resolution === "answered" || body.resolution === "declined";
    if (isAsk !== askResolution) {
      throw new HubError("invalid_field", `resolution ${body.resolution} does not match a ${record.message.type} (§7/§8.8)`);
    }
    if (body.resolution === "answered") this.validateAnswerValue(record.message as AskMessage, body.value);
    if (record.status !== "open") {
      const existing = record.response as A2hResponse;
      throw new HubError("already_terminal", `message already ${record.status}`, {
        id: record.id,
        status: record.status,
        resolution: existing.resolution,
      });
    }
    // Expiry-vs-answer (§7): a resolve strictly after expires_at loses to the default expiry,
    // evaluated against the same clock — the caller reads the real (expired) outcome via the 409.
    if (record.expiresAtMs !== null && t > record.expiresAtMs) {
      this.applyDefaultExpiry(record, t);
      throw new HubError("already_terminal", `message expired at ${new Date(record.expiresAtMs).toISOString()}`, {
        id: record.id,
        status: record.status,
        resolution: "expired",
      });
    }
    applyResolution(record, {
      resolution: body.resolution,
      actor,
      resolved_at: new Date(t).toISOString(),
      resolution_id: newResolutionId(),
      ...(body.value !== undefined ? { value: body.value } : {}),
      ...(body.comment !== undefined ? { comment: body.comment } : {}),
      ...(body.checklist !== undefined ? { checklist: body.checklist } : {}),
      ...(record.message.state !== undefined ? { state: record.message.state } : {}),
    });
    this.emitResponse(record);
    // §8.8 pins the resolve success body to `{ id, status, resolution_id }`. The RESOLVER is the
    // addressee — a different, potentially hostile principal — so the returned Response MUST NOT
    // carry the submitter's opaque `state` resume blob (§8.7.1 strips it from the forward-leg
    // delivered form for exactly this reason; it round-trips only on the submitter's own §6
    // channels). Strip it here so the resolve return can't leak it backward.
    const full = record.response as A2hResponse;
    const { state: _submitterState, ...responseSansState } = full;
    return {
      id: record.id,
      status: record.status,
      resolution_id: record.resolution_id as string,
      response: responseSansState,
    };
  }

  /**
   * Hub-enforced value-vs-request validation for `resolution: "answered"` (spec §8.8): a
   * `select`/`confirm` answer must be a string member of the option values (`confirm` without
   * options uses the synthesized approve/deny pair, §5.2); an `input` answer must be an object that
   * VALIDATES against the ask's `request.schema` — otherwise a resolver could emit a value that
   * violates the sender's contract and the Hub would sign it into a terminal Response.
   */
  private validateAnswerValue(message: AskMessage, value: string | JsonObject | undefined): void {
    if (value === undefined) {
      throw new HubError("invalid_field", "resolution `answered` requires `value` (§8.8)");
    }
    const mode = message.request.mode;
    if (mode === "input") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HubError("invalid_field", "an input-mode answer must be an object (§5.2/§8.8)");
      }
      // §5.2/§8.8: the answer object MUST validate against the request's flat JSON Schema (a
      // missing `schema` is a malformed input-mode request the submit path already rejects).
      if (message.request.schema !== undefined) {
        const v = validateAgainstSchema(message.request.schema, value);
        if (!v.valid) {
          throw new HubError("invalid_field", `input answer does not satisfy request.schema: ${v.errors.join("; ")} (§5.2/§8.8)`);
        }
      }
      return;
    }
    const options =
      message.request.options !== undefined && message.request.options.length > 0
        ? message.request.options.map((o) => o.value)
        : mode === "confirm"
          ? ["approve", "deny"]
          : [];
    if (typeof value !== "string" || !options.includes(value)) {
      throw new HubError("invalid_field", `value must be one of [${options.join(", ")}] (§5.2/§8.8)`);
    }
  }

  private callbackOf(message: A2hMessage): Callback | undefined {
    // Defensive `?.`: reached from `negotiateVersion` BEFORE schema validation, where a malformed
    // pre-0.3 ask/task may lack `request`/`action`. Read the callback without assuming structure so
    // version negotiation never throws a raw TypeError ahead of the `validation_error` it should yield.
    if (message.type === "ask") return message.request?.callback;
    if (message.type === "task") return message.action?.callback;
    return undefined;
  }

  /**
   * Emit a freshly-applied Response through every configured channel (spec §6/§8.8): the §8.3 push
   * callback (when configured), the always-available §8.2 pull, and — when the Caller registered a
   * session that is LIVE at resolution time — the session's mailbox as a `response` entry (§8.7).
   * Dual-path delivery is safe: every channel carries the same `resolution_id` and the agent dedups
   * on `(in_reply_to, resolution_id)`.
   */
  private emitResponse(record: MessageRecord): void {
    this.deliver(record);
    this.deliverResponseEntry(record);
  }

  /**
   * Enqueue the §8.7 `response` entry to the submitting session's mailbox (spec §6). If the Caller
   * registered no session, or its session is terminal by resolution time, this is a silent no-op —
   * delivery falls back to the unchanged v0.4 path (pull authoritative, plus any callback) with
   * **no bounce emitted** (no session ⇒ pure v0.4 return path). Enqueuing is NOT delivery evidence;
   * only the session's own drain (or ack) advances the response track (§15.1).
   */
  private deliverResponseEntry(record: MessageRecord): void {
    const response = record.response;
    const sessionId = record.message.agent.session;
    if (!response || sessionId === undefined) return;
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.session.state !== "active") return;
    this.responseAckIndex.set(response.resolution_id, record.id);
    const box = this.mailboxes.get(record.message.agent.id) ?? [];
    box.push({
      kind: "response",
      response: structuredClone(response),
      ackKey: response.resolution_id,
      addressedSession: sessionId,
      invisibleUntilMs: 0,
      acked: false,
      enqueuedAtMs: this.now(),
    });
    this.mailboxes.set(record.message.agent.id, box);
  }

  private deliver(record: MessageRecord): void {
    const response = record.response;
    if (!response || !this.onDeliver) return;
    const callback = this.callbackOf(record.message);
    if (!callback || callback.mode !== "push") return; // pull mode: agent will GET
    const sc = buildSignedContext({
      ma2h_version: response.ma2h_version,
      callback_url: callback.url,
      id: record.id,
      in_reply_to: response.in_reply_to,
      jti: newJti(),
      // §9.2: bind the response payload (value/comment/actor/edited/state) into the signature.
      payload_sha256: computePayloadSha256(response.response, response.state),
      resolution: response.resolution,
      resolution_id: response.resolution_id,
      resolved_at: response.response?.resolved_at ?? new Date(this.now()).toISOString(),
      t: Math.floor(this.now() / 1000),
    });
    const { header } = signResponse(sc, { key: this.signingKey });
    this.onDeliver({ callback, response, signature: header });
    // receipt track: mark delivered-to-agent ONLY after the push succeeds (onDeliver didn't throw).
    // A failed push must not claim receipt — the agent gets it via the pull GET fallback instead (§14.2).
    this.markDeliveredToAgent(record.id, this.now());
  }

  // ---- Acknowledgment / receipt (spec §14) + presence (spec §15) ----

  /** Assemble a Hub-attested ack envelope (spec §14.1). */
  private buildAck(inReplyTo: string, principal: string, nowMs: number, note?: string, resolutionId?: string): Ack {
    return {
      ma2h_version: MA2H_VERSION,
      type: "ack",
      in_reply_to: inReplyTo,
      by: `agent:${principal}`,
      acked_at: new Date(nowMs).toISOString(),
      ...(note !== undefined ? { note } : {}),
      ...(resolutionId !== undefined ? { resolution_id: resolutionId } : {}),
    };
  }

  /**
   * Advance an ask/task's receipt track to `delivered-to-agent` (spec §14.2) — only from the
   * initial (absent) state: `acknowledged` and the v0.5 terminal `expired` are immutable (a pull
   * after the track expired must not resurrect it — on a production Hub the record is purged and
   * the pull is a 410; the in-memory reference keeps the record but honors the terminal).
   */
  private markDeliveredToAgent(id: string, nowMs: number): void {
    const d = this.deliveries.get(id);
    if (d !== undefined) return;
    this.deliveries.set(id, { state: "delivered-to-agent", delivered_at: new Date(nowMs).toISOString() });
    // (The response-receipt owner is the submitting agent's owner, resolved at read time in getDelivery.)
  }

  /**
   * Response-leg acknowledgment (spec §14.3): `POST /v1/messages/{id}/ack`. The **submitting** agent
   * acks it received the answer. Submitter-bound (§9.1): a foreign/unknown id is `not_found`. The message
   * MUST be terminal (a resolution exists) — acking an `open` message is refused. First-ack-wins: a repeat
   * returns the existing ack. Returns the ack envelope (the human reads it via §14.4).
   */
  ackMessage(id: string, principal: string, opts?: { note?: string; now?: number }): Ack {
    const record = this.store.get(id);
    if (!record || record.message.agent.id !== principal) {
      throw new HubError("not_found", `unknown message: ${id}`);
    }
    if (record.status === "open" || record.message.type === "notify") {
      throw new HubError("not_acknowledgeable", "only a terminal ask/task response can be acknowledged (§14.3)");
    }
    const existing = this.deliveries.get(id);
    // first-ack-wins, idempotent — return a CLONE so a caller can't mutate the stored immutable receipt.
    if (existing?.state === "acknowledged" && existing.ack) return structuredClone(existing.ack);
    // §14.2: the agent can only acknowledge an answer it actually RECEIVED — the receipt must be
    // `delivered-to-agent` (a push 2xx or the agent's authenticated GET) before it can advance to
    // `acknowledged`. This stops a client polling /ack to fake a receipt without ever fetching the answer.
    if (existing?.state !== "delivered-to-agent") {
      throw new HubError("not_acknowledgeable", "the response must be delivered to the agent before it can be acknowledged (§14.2)");
    }
    const t = opts?.now ?? this.now();
    // The Hub attests the ack, so it stamps the AUTHORITATIVE resolution_id (the message's one terminal
    // resolution) — never a client-supplied value, which a buggy/malicious agent could use to make the
    // receipt claim a different resolution.
    const ack = this.buildAck(id, principal, t, opts?.note, record.resolution_id ?? undefined);
    this.deliveries.set(id, {
      state: "acknowledged",
      ...(existing.delivered_at !== undefined ? { delivered_at: existing.delivered_at } : {}),
      acknowledged_at: ack.acked_at,
      ack: structuredClone(ack), // store a clone so a caller mutating the returned ack can't alter it
    });
    return ack;
  }

  /**
   * Detached signature for a **pushed** ack (spec §14.4), for a Hub that pushes acks to a human's client.
   * Pulled acks are transport-trusted and unsigned. Returns the `MA2H-Signature` header (fresh `t`/`jti`).
   */
  signAckForPush(ack: Ack, nowMs?: number): string {
    const t = nowMs ?? this.now();
    const sc = buildAckSignedContext({
      ack_sha256: computeAckSha256(ack),
      by: ack.by,
      in_reply_to: ack.in_reply_to,
      jti: newJti(),
      ma2h_version: ack.ma2h_version,
      t: Math.floor(t / 1000),
    });
    return signAck(sc, { key: this.signingKey }).header;
  }

  /** Record a per-`agent.id` `last_seen` from authenticated poll/subscription activity (spec §15.1). */
  private recordActivity(principal: string, nowMs: number): void {
    this.lastSeen.set(principal, nowMs);
  }

  /** Register an agent's owning human (models per-account provisioning for presence authz, §15.3). */
  setAgentOwner(agentId: string, owner: string): void {
    this.presenceOwners.set(agentId, owner);
  }

  /**
   * Opt an account (by owning human) into the inter-agent leg (spec §8.0 `inter_agent.enabled`,
   * §13.5 layer 1). The leg defaults OFF: until an account opts in, the Hub MUST NOT accept
   * `to`-addressed submits from it. `enabled: false` (or the default) turns it back off.
   */
  setInterAgentEnabled(owner: string, enabled = true): void {
    if (enabled) this.interAgentOwners.add(owner);
    else this.interAgentOwners.delete(owner);
  }

  /**
   * Is `caller` the account's authenticated HUMAN for `agentId` (spec §16.4)? The owner-value match
   * alone is namespace-unsafe: `presenceOwners` VALUES are human ids (`human:you`) while an agent
   * CREDENTIAL is a bare principal, and an agent could be provisioned with an id string equal to a
   * human owner id — letting it impersonate the account human's kill-switch / reads. The guard
   * `!presenceOwners.has(caller)` closes that: a genuine human owner is never itself a provisioned
   * agent (owners are values, never keys), so an agent principal — always a key — is disqualified.
   */
  private isAccountHuman(agentId: string, caller: string): boolean {
    return this.presenceOwners.get(agentId) === caller && !this.presenceOwners.has(caller);
  }

  /**
   * Presence read (spec §15.3): derive `online`/`offline`/`unknown` for an agent from its `last_seen`.
   * **Owner-only:** `caller` is the requesting human; an agent not owned by `caller` reads as `unknown`
   * with NO `last_seen`, so a non-owner never learns another agent's activity timing.
   */
  getPresence(agentId: string, caller: string, nowMs?: number): Presence {
    const freshness_seconds = this.presenceFreshnessSeconds;
    if (!this.isAccountHuman(agentId, caller)) {
      return { agent_id: agentId, state: "unknown", freshness_seconds };
    }
    const t = nowMs ?? this.now();
    const seen = this.lastSeen.get(agentId);
    let state: PresenceState;
    if (seen === undefined) state = "unknown";
    else state = t - seen <= freshness_seconds * 1000 ? "online" : "offline";
    return {
      agent_id: agentId,
      state,
      ...(seen !== undefined ? { last_seen: new Date(seen).toISOString() } : {}),
      freshness_seconds,
    };
  }

  // ---- Inbound leg — human → agent directives (spec §8.7, §13) ----

  /**
   * Enqueue a human→agent directive (spec §13). The Hub attests `from` (here supplied by the trusted
   * caller standing in for the operator session), assigns the `id`, and appends to the addressee's
   * durable, FIFO mailbox. Returns the assigned id. No Response is ever emitted for a directive (§13.3).
   *
   * v0.5 (§13.2, retroactively REQUIRED): the §4 submit-time destination validation applies to the
   * directive `to` — unknown agent → `422 unknown_destination`; unknown session → `422`; terminal
   * session → `410 destination_gone`. A directive MAY be session-addressed (`agent:<id>#<session>`):
   * it is then visible only to drains presenting that session and participates in the §14.2 bounce.
   * (The author here is the account's human, who always has session visibility — §16.4 — so the §4
   * visibility collapse never applies on this path.)
   */
  sendDirective(input: SendDirectiveInput): { id: string } {
    const t = this.now();
    this.settleSessions(t);
    const parsed = Hub.parseAddress(input.to);
    if (!parsed) throw new HubError("validation_error", `malformed destination: ${input.to} (§4 grammar)`);
    if (!this.presenceOwners.has(parsed.principal)) {
      throw new HubError("unknown_destination", `unknown destination: ${input.to} (§13.2)`);
    }
    if (parsed.session !== undefined) {
      const rec = this.sessions.get(parsed.session);
      if (!rec || rec.session.agent_id !== parsed.principal) {
        throw new HubError("unknown_destination", `unknown destination: ${input.to} (§13.2)`);
      }
      if (rec.session.state !== "active") {
        throw new HubError("destination_gone", `destination session ${parsed.session} is ${rec.session.state} (§13.2)`);
      }
    }
    const id = newDirectiveId();
    const directive: InboundDirective = {
      ma2h_version: MA2H_VERSION,
      type: "directive",
      id,
      from: input.from,
      to: input.to,
      created_at: new Date(t).toISOString(),
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
    };
    // Hub-minted directives are v0.5-versioned, so they validate against the v0.5 snapshot (which
    // enforces the dir_ namespace + first-`#` grammar the §8.7.1 ack-key rules rely on).
    const v = validateV05("inbound-message.schema.json", directive);
    if (!v.valid) throw new HubError("validation_error", `invalid directive: ${v.errors.join("; ")}`);
    // §13.1: `expires_at` MUST be in the future at author time. Enqueuing an already-expired directive
    // would hand the caller a success `id` for a directive no agent can ever drain (the next drain drops
    // it), so reject it up front — the inbound mirror of the §8.5 `422 invalid_field` for a past expiry.
    if (directive.expires_at !== undefined && Date.parse(directive.expires_at) <= t) {
      throw new HubError("invalid_field", `expires_at ${directive.expires_at} is not in the future (§13.1)`);
    }
    const box = this.mailboxes.get(parsed.principal) ?? [];
    // Store a deep copy so a later mutation of the caller's input object cannot alter the durable record.
    box.push({
      kind: "directive",
      directive: structuredClone(directive),
      ackKey: id,
      ...(parsed.session !== undefined ? { addressedSession: parsed.session } : {}),
      invisibleUntilMs: 0,
      acked: false,
      enqueuedAtMs: t,
    });
    this.mailboxes.set(parsed.principal, box);
    this.directiveDeliveries.set(id, { state: "queued" }); // receipt track begins (§14.2)
    this.deliveryOwners.set(id, input.from); // the human who sent it owns the receipt (§14.4)
    // Best-effort webhook push mirrors §8.3; modelled via onDeliver is out of scope here — pull is the
    // source of truth (§8.7), which the reference exercises. Production Hubs add the push per §13.2.
    // The §8.7 webhook stays DIRECTIVES-ONLY in v0.5 (§8.7.1) — the v0.5 entry kinds never ride it.
    return { id };
  }

  /**
   * Drain up to `max` pending entries for the authenticated `principal` (its `agent.id` — the mailbox
   * key; §9.1 binds the mailbox to the credential, never a request field). FIFO on first delivery; each
   * returned entry is re-signed with a fresh `t`/`jti` (§9.7/§9.8 per-delivery signing) and marked
   * in-flight for the visibility window, so an un-acked entry is redelivered later (at-least-once).
   *
   * **A session-less drain returns exactly the v0.4 shape** (spec §8.7.1): principal-addressed
   * directives only — a 0.4 consumer never sees an unknown entry shape. Presenting `?session=`
   * (the caller's own LIVE session; foreign/unknown → 404, own-terminal → 410) additionally yields
   * session-addressed entries for that session, principal-addressed `message` entries
   * (first-claim-wins under the visibility window), and `response`/`receipt` entries for that
   * session. A drain is client-originated activity: it renews the presented session's lease (§16.2)
   * and stamps `delivered` on what it returns (§15.1 truthfulness).
   */
  drainInbox(principal: string, opts: { max?: number; now?: number; session: string }): InboxEntryDelivery[];
  drainInbox(principal: string, opts?: { max?: number; now?: number }): InboundDelivery[];
  drainInbox(principal: string, opts?: { max?: number; now?: number; session?: string }): InboxEntryDelivery[] {
    const t = opts?.now ?? this.now();
    this.settleSessions(t);
    this.recordActivity(principal, t); // draining the mailbox is presence activity (§15.1)
    const presented = opts?.session !== undefined ? this.presentSession(principal, opts.session, t) : undefined;
    const box = this.mailboxes.get(principal);
    if (!box) return [];
    // Coerce `max` defensively: a non-finite value (e.g. a NaN from parsing `?max=abc`) MUST NOT
    // silently disable the cap — `out.length >= NaN` is always false, which would drain the whole
    // mailbox. Fall back to unbounded only for an explicitly absent max.
    const rawMax = opts?.max;
    const max = rawMax === undefined ? Number.POSITIVE_INFINITY : Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : 0;
    const out: InboxEntryDelivery[] = [];
    for (const rec of box) {
      if (out.length >= max) break;
      if (rec.acked) continue;
      if (this.expireEntry(rec, t)) continue;
      if (!Hub.entryVisibleTo(rec, presented?.session.id)) continue;
      if (rec.invisibleUntilMs > t) continue;
      // The visibility window IS the claim (first-claim-wins for principal-addressed entries):
      // a concurrent sibling drain within the window cannot see this entry.
      rec.invisibleUntilMs = t + this.visibilityMs;
      if (presented !== undefined) rec.claimedBySession = presented.session.id;
      this.stampDelivered(rec, t);
      out.push(this.signEntry(rec, principal, presented?.session.id, t));
    }
    // Compact acked records out — including ones `expireEntry` just dropped (§13.3). Otherwise an
    // expired-but-never-acked entry would linger and be re-scanned on every drain, since the ack
    // that would normally remove it never comes for an entry that simply expired.
    if (box.some((r) => r.acked)) this.mailboxes.set(principal, box.filter((r) => !r.acked));
    return out;
  }

  /** Which drains may see an entry (spec §8.7.1). `presentedSession` is undefined for a session-less drain. */
  private static entryVisibleTo(rec: EntryRecord, presentedSession: string | undefined): boolean {
    if (rec.addressedSession !== undefined) return rec.addressedSession === presentedSession;
    // Principal-addressed: a directive keeps its v0.4 any-drain visibility; the v0.5 entry kinds
    // are delivered ONLY to session-presenting drains (a session-less drain stays v0.4-shaped).
    if (rec.kind === "directive") return true;
    return presentedSession !== undefined;
  }

  /** Stamp CLIENT-ORIGINATED delivery evidence for a drained entry, per kind (spec §14.2/§15.1). */
  private stampDelivered(rec: EntryRecord, t: number): void {
    if (rec.deliveredAtMs !== undefined) return;
    rec.deliveredAtMs = t;
    if (rec.kind === "directive") {
      this.directiveDeliveries.set(rec.directive.id, { state: "delivered", delivered_at: new Date(t).toISOString() });
    } else if (rec.kind === "message") {
      const track = this.mailboxTracks.get(rec.message.id);
      if (track && track.state === "queued") {
        track.state = "delivered";
        track.deliveredAtMs = t;
        this.mirrorAddressedNotifyStatus(rec.message.id, "delivered");
      }
    } else if (rec.kind === "response") {
      // The drain that delivered the entry stamps `delivered-to-agent` (spec §8.7.1) — the same
      // client-originated evidence as the submitter's authenticated GET.
      this.markDeliveredToAgent(rec.response.in_reply_to, t);
    }
    // receipt: no track — receipts are best-effort and generate nothing (§8.7.1).
  }

  /** Keep an ADDRESSED notify's `status` mirroring its mailbox track (spec §5.1). */
  private mirrorAddressedNotifyStatus(messageId: string, state: MailboxState): void {
    const record = this.store.get(messageId);
    if (record && record.message.type === "notify" && record.message.to !== undefined) {
      record.status = state as Status;
    }
  }

  /** Detached per-kind signature for one entry delivery (fresh `t`/`jti`; spec §9.7/§9.8). */
  private signEntry(
    rec: EntryRecord,
    principal: string,
    presentedSession: string | undefined,
    t: number,
  ): InboxEntryDelivery {
    if (rec.kind === "directive") {
      return { directive: structuredClone(rec.directive), signature: this.signDirective(rec.directive, t) };
    }
    if (rec.kind === "message") {
      const sc = buildMessageEntrySignedContext({
        from: rec.message.from,
        id: rec.message.id,
        jti: newJti(),
        ma2h_version: rec.message.ma2h_version,
        payload_sha256: computeMessageEntryPayloadSha256(rec.message),
        t: Math.floor(t / 1000),
        to: rec.message.to,
      });
      return { message: structuredClone(rec.message), signature: signMessageEntry(sc, { key: this.signingKey }).header };
    }
    if (rec.kind === "response") {
      const response = rec.response;
      // The destination binding is the SESSION the entry is delivered to (spec §9.8): the drainer
      // reconstructs it from its own presented identity. A response entry always carries its
      // addressed session (deliverResponseEntry sets it), which visibility guarantees equals the
      // presented session; the fallback only documents that equivalence for the type system.
      const to = `agent:${principal}#${rec.addressedSession ?? presentedSession}` as AgentAddress;
      const sc = buildResponseEntrySignedContext({
        id: response.in_reply_to,
        in_reply_to: response.in_reply_to,
        jti: newJti(),
        ma2h_version: response.ma2h_version,
        payload_sha256: computePayloadSha256(response.response, response.state),
        resolution: response.resolution,
        resolution_id: response.resolution_id,
        resolved_at: response.response?.resolved_at ?? null,
        t: Math.floor(t / 1000),
        to,
      });
      return { response: structuredClone(response), signature: signResponseEntry(sc, { key: this.signingKey }).header };
    }
    const receipt = rec.receipt;
    const sc = buildReceiptSignedContext({
      in_reply_to: receipt.in_reply_to,
      jti: newJti(),
      ma2h_version: receipt.ma2h_version,
      receipt_sha256: computeReceiptSha256(receipt),
      t: Math.floor(t / 1000),
      to: receipt.to,
    });
    return { receipt: structuredClone(receipt), signature: signReceipt(sc, { key: this.signingKey }).header };
  }

  /**
   * Model of a §8.7.2 SSE stream push: the same session-scoped entries as the drain, claimed under
   * the same visibility window — but a stream push is SERVER-originated, so it is deliberately NOT
   * delivery evidence (spec §8.7.2/§15.1): the mailbox track stays `queued`; only a later ack (or a
   * drain) advances it, and an un-acked stream claim reverts to queued-visible after the window.
   * The connect itself IS client-originated (the session presentation renews the lease), mirroring
   * a stream (re)connect; the pushes that follow are not.
   */
  streamClaim(principal: string, sessionId: string, opts?: { max?: number; now?: number }): InboxEntryDelivery[] {
    const t = opts?.now ?? this.now();
    this.settleSessions(t);
    const presented = this.presentSession(principal, sessionId, t);
    const box = this.mailboxes.get(principal);
    if (!box) return [];
    const rawMax = opts?.max;
    const max = rawMax === undefined ? Number.POSITIVE_INFINITY : Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : 0;
    const out: InboxEntryDelivery[] = [];
    for (const rec of box) {
      if (out.length >= max) break;
      if (rec.acked) continue;
      if (this.expireEntry(rec, t)) continue;
      if (!Hub.entryVisibleTo(rec, presented.session.id)) continue;
      if (rec.invisibleUntilMs > t) continue;
      rec.invisibleUntilMs = t + this.visibilityMs; // starts the window exactly like a drain claim
      rec.claimedBySession = presented.session.id;
      rec.streamClaimedAtMs = t; // presented to the client — ackable — but NOT delivery evidence
      out.push(this.signEntry(rec, principal, presented.session.id, t));
    }
    if (box.some((r) => r.acked)) this.mailboxes.set(principal, box.filter((r) => !r.acked));
    return out;
  }

  /**
   * Consume (ack) processed entries for `principal` (spec §8.7). The mailbox consume **is** the
   * acknowledgment/receipt (§14.3), extended in v0.5 to every entry kind by its pinned ack key
   * (§8.7.1): a directive's/`message` entry's `id`, a `response` entry's `resolution_id`, a
   * `receipt` entry's `id`. Removes matching records from the caller's OWN mailbox only; ids not in
   * it are no-ops (and reveal nothing about other mailboxes). Idempotent.
   *
   * Session presentation (`?session=`, spec §8.7): validated under exactly the drain rules
   * (foreign/unknown → 404, own-terminal → 410) and affecting LEASE ATTRIBUTION ONLY — the renewal
   * — never ack authorization, which stays credential-scoped. A session-less ack renews no lease.
   *
   * Per-kind track effects (§8.7.1): directive → `acknowledged` (v0.4, unchanged); `message` entry
   * → the addressed message's mailbox track `acknowledged` (what the sender's §8.2 view reports);
   * `response` entry → equivalent to a note-less `POST /v1/messages/{id}/ack` (first-ack-wins with
   * that path); `receipt` entry → consume only (no track, generates nothing).
   */
  ackInbox(
    principal: string,
    ids: string[],
    opts?: { note?: string; now?: number; session?: string },
  ): { acked: number; acks: Ack[] } {
    const t = opts?.now ?? this.now();
    this.settleSessions(t);
    if (opts?.session !== undefined) this.presentSession(principal, opts.session, t);
    const box = this.mailboxes.get(principal);
    if (!box) return { acked: 0, acks: [] };
    const wanted = new Set(ids);
    let acked = 0;
    const acks: Ack[] = [];
    const done = new Set<string>();
    for (const rec of box) {
      // Only a PRESENTED entry can be acknowledged — one the caller was shown by a drain (delivery
      // evidence) or a stream push (provisional, §8.7.2). A still-`queued` id that was never
      // presented is a no-op, so a client can't skip the drain and fabricate a receipt (§14.2).
      const presented = rec.deliveredAtMs !== undefined || rec.streamClaimedAtMs !== undefined;
      if (rec.acked || !wanted.has(rec.ackKey) || !presented) continue;
      // A consume arriving after `expires_at` loses to expiry (§13.3) — the entry is dropped and its
      // receipt becomes terminal, never a false `acknowledged`. (expireEntry marks it for compaction.)
      if (this.expireEntry(rec, t)) continue;
      rec.acked = true;
      done.add(rec.ackKey);
      acked++;
      if (rec.kind === "directive") {
        rec.ack = this.buildAck(rec.directive.id, principal, t, opts?.note);
        // Persist the receipt BEFORE the record is compacted out below — else the human-facing ack is
        // lost the moment ackInbox returns and no status view could show the directive was acknowledged.
        // Store a CLONE so a caller mutating the returned ack cannot alter the immutable stored receipt.
        this.directiveDeliveries.set(rec.directive.id, {
          state: "acknowledged",
          delivered_at: new Date(rec.deliveredAtMs ?? t).toISOString(),
          acknowledged_at: rec.ack.acked_at,
          ack: structuredClone(rec.ack),
        });
        acks.push(rec.ack);
      } else if (rec.kind === "message") {
        // The ack IS the client-originated receipt evidence: a stream-claimed entry that was never
        // drained stamps `delivered` at ack time (§8.7.2 — the track advances on its ack).
        rec.ack = this.buildAck(rec.message.id, principal, t, opts?.note);
        const track = this.mailboxTracks.get(rec.message.id);
        if (track && (track.state === "queued" || track.state === "delivered")) {
          track.state = "acknowledged";
          track.deliveredAtMs = rec.deliveredAtMs ?? track.deliveredAtMs ?? t;
          track.acknowledgedAtMs = t;
          track.ack = structuredClone(rec.ack);
          this.mirrorAddressedNotifyStatus(rec.message.id, "acknowledged");
        }
        acks.push(rec.ack);
      } else if (rec.kind === "response") {
        // Equivalent to a note-less response-leg ack (§8.7.1): the drainer IS the submitting
        // principal. First-ack-wins with `ackMessage` — whichever lands first, the other no-ops.
        const messageId = rec.response.in_reply_to;
        const existing = this.deliveries.get(messageId);
        if (existing?.state === "acknowledged") {
          if (existing.ack) acks.push(structuredClone(existing.ack));
        } else if (existing?.state === "expired") {
          // The v0.5 response-track terminal `expired` (§14.2) is immutable: the answer was NEVER
          // seen. Consume the stale entry but do NOT resurrect the track to `acknowledged` — that
          // would tell the human the answer was received when the track already asserted it wasn't.
        } else {
          this.markDeliveredToAgent(messageId, rec.deliveredAtMs ?? t);
          const ack = this.buildAck(messageId, principal, t, opts?.note, rec.response.resolution_id);
          const delivered = this.deliveries.get(messageId);
          this.deliveries.set(messageId, {
            state: "acknowledged",
            ...(delivered?.delivered_at !== undefined ? { delivered_at: delivered.delivered_at } : {}),
            acknowledged_at: ack.acked_at,
            ack: structuredClone(ack),
          });
          acks.push(ack);
        }
      }
      // receipt: consume only — receipts have no track and generate nothing (§8.7.1).
    }
    // Idempotent retry (§14.1): the mailbox record is compacted after the first ack, so a re-ack of
    // the same key returns the existing immutable receipt — bound to THIS principal via the ack's
    // `by`, and returned as a clone. Directive and message-entry receipts live in their own stores;
    // response-entry re-acks surface the response-leg receipt (the §14.3 fold — same receipt).
    for (const id of wanted) {
      if (done.has(id)) continue;
      const d = this.directiveDeliveries.get(id);
      if (d?.state === "acknowledged" && d.ack?.by === `agent:${principal}`) {
        acks.push(structuredClone(d.ack));
        continue;
      }
      const m = this.mailboxTracks.get(id);
      if (m?.state === "acknowledged" && m.ack?.by === `agent:${principal}`) {
        acks.push(structuredClone(m.ack));
        continue;
      }
      const messageId = this.responseAckIndex.get(id);
      if (messageId !== undefined) {
        const r = this.deliveries.get(messageId);
        // Bind to THIS principal via the ack's `by` (§8.7/§9.1), exactly as the directive and
        // mailbox-track branches above — otherwise a non-submitting principal that holds a foreign
        // `resolution_id` (the addressee always does — resolveAsAgent returns it) could read the
        // submitter's private ack (its `note`, `acked_at`, message id).
        if (r?.state === "acknowledged" && r.ack?.by === `agent:${principal}`) acks.push(structuredClone(r.ack));
      }
    }
    // Compact acked records out of the mailbox (the receipts live on in their track stores).
    this.mailboxes.set(
      principal,
      box.filter((r) => !r.acked),
    );
    return { acked, acks };
  }

  /**
   * Read a message/directive receipt track (spec §14.2), by id — the human's **owner-authenticated** pull
   * path for a pulled ack (§14.4), distinct from the submitter-bound message GET. `caller` is the requesting
   * human; a caller that does not own the receipt gets `undefined` (never another owner's notes/timing).
   * Returns a clone so the stored receipt stays immutable.
   */
  getDelivery(id: string, caller: string): Delivery | undefined {
    const dir = this.directiveDeliveries.get(id);
    if (dir !== undefined) {
      // Directive receipt: the owner is the `from` snapshotted at send time (§14.4).
      return this.deliveryOwners.get(id) === caller ? structuredClone(dir) : undefined;
    }
    const msg = this.deliveries.get(id);
    if (msg !== undefined) {
      // Response receipt: the owner is the submitting agent's owner, resolved at READ time — so
      // provisioning via setAgentOwner at any point before the read enables the human's §14.4 read path.
      const owner = this.presenceOwners.get(this.store.get(id)?.message.agent.id ?? "");
      return owner !== undefined && owner === caller ? structuredClone(msg) : undefined;
    }
    return undefined;
  }

  /** Detached §9.7 signature for one directive delivery (fresh `t`/`jti`). */
  private signDirective(directive: InboundDirective, nowMs: number): string {
    const sc = buildInboundSignedContext({
      from: directive.from,
      id: directive.id,
      jti: newJti(),
      ma2h_version: directive.ma2h_version,
      payload_sha256: computeDirectivePayloadSha256(directive),
      t: Math.floor(nowMs / 1000),
      to: directive.to,
    });
    return signInbound(sc, { key: this.signingKey }).header;
  }

  /**
   * Mark an entry acked (dropped) if past its `expires_at` (spec §13.3, and the message-level
   * `expires_at` for addressed `message` entries). Returns true if expired-and-dropped.
   *
   * Track honesty (§14.2): `expired` MUST mean NEVER delivered — an already-delivered entry that
   * expires is only dropped from redelivery (its track keeps the truthful `delivered`, the
   * "seen but unanswered" reading). A queued `message` entry expiring also fires the ordinary §7
   * expiry on its record (same clock; `default_on_expire` applies) — the Hub drops expired entries
   * before delivery, so no addressee can ever resolve it.
   */
  private expireEntry(rec: EntryRecord, nowMs: number): boolean {
    if (rec.kind === "response" || rec.kind === "receipt") return false; // retention-only kinds
    const expiresAt = rec.kind === "directive" ? rec.directive.expires_at : rec.message.expires_at;
    if (expiresAt === undefined) return false;
    if (nowMs <= Date.parse(expiresAt)) return false;
    rec.acked = true; // dropped: never delivered again (no redelivery — §13.3)
    if (rec.kind === "directive") {
      if (rec.deliveredAtMs === undefined) {
        // Advance the receipt track to a terminal `expired` so `getDelivery` stops reporting `queued`
        // forever for a directive the Hub has dropped (§13.3 / §14.2).
        this.directiveDeliveries.set(rec.directive.id, { state: "expired" });
      }
      return true;
    }
    const track = this.mailboxTracks.get(rec.message.id);
    if (track && track.state === "queued") {
      track.state = "expired";
      this.mirrorAddressedNotifyStatus(rec.message.id, "expired");
    }
    const record = this.store.get(rec.message.id);
    if (record && record.message.type !== "notify") this.applyDefaultExpiry(record, nowMs);
    return true;
  }

  // ---- v0.5 delivery honesty: bounce + retention (spec §14.2, §16.3) ----

  /**
   * The §16.3 terminal-session obligation: bounce every un-acked SESSION-ADDRESSED command entry
   * (directives and `message` entries — including entries a bridge drained but never acked, the
   * §13.4 crash window), with the auto-resolutions. Principal-addressed entries do NOT bounce on a
   * single session's death (a sibling rescues them via visibility-timeout redelivery, §8.7);
   * `response`/`receipt` entries never bounce — they are conveniences over state the Hub holds
   * durably, so they are silently dropped (the §8.2 pull stays authoritative).
   */
  private bounceSessionMail(dead: SessionRecord, atMs: number): void {
    const box = this.mailboxes.get(dead.session.agent_id);
    if (!box) return;
    for (const rec of box) {
      if (rec.acked || rec.addressedSession !== dead.session.id) continue;
      if (rec.kind === "response" || rec.kind === "receipt") {
        rec.acked = true; // superseded by / best-effort beside the durable pull state
        continue;
      }
      // Expiry-vs-bounce, same clock (§7/§14.2): a NEVER-delivered entry whose `expires_at` already
      // fired was never seen — its mailbox track is `expired` (and an ask/task auto-resolves via
      // expireEntry's default expiry), NOT `bounced`, so a corpse the Hub should have dropped is not
      // reported as seen-then-lost with a receipt. A DELIVERED-but-unacked entry stays a bounce
      // (`prior:"delivered"` — seen-then-orphaned) regardless of its own expiry, since `expired`
      // MUST mean never delivered (§14.2); so only settle expiry on the not-yet-delivered path.
      if (rec.deliveredAtMs === undefined && this.expireEntry(rec, atMs)) continue;
      this.bounceEntry(rec, dead.session.id, atMs);
    }
    this.mailboxes.set(
      dead.session.agent_id,
      box.filter((r) => !r.acked),
    );
  }

  /**
   * Bounce one un-acked command entry (spec §14.2): terminal `bounced` on its track — `prior`
   * preserving never-seen (`queued`) vs seen-then-orphaned (`delivered`) — the `system:undeliverable`
   * auto-resolution for an addressed ask/task, and a best-effort `receipt` entry to the sender's
   * live submitting session (agent senders only; a directive's human author reads the §14.4 track).
   */
  private bounceEntry(rec: EntryRecord, deadSessionId: string, atMs: number): void {
    if (rec.kind !== "directive" && rec.kind !== "message") return;
    const prior: "queued" | "delivered" = rec.deliveredAtMs !== undefined ? "delivered" : "queued";
    rec.acked = true; // consumed: a terminal destination can never drain it again
    if (rec.kind === "directive") {
      // §14.2: a surfaced delivery record SHOULD carry the explicit `prior` on its `bounced`
      // terminal — stamped here, once, from the same derivation as the receipt below.
      this.directiveDeliveries.set(rec.directive.id, {
        state: "bounced",
        prior,
        ...(rec.deliveredAtMs !== undefined ? { delivered_at: new Date(rec.deliveredAtMs).toISOString() } : {}),
      });
      return;
    }
    const track = this.mailboxTracks.get(rec.message.id);
    if (track && track.state !== "acknowledged" && track.state !== "bounced" && track.state !== "expired") {
      track.state = "bounced";
      // Stamped ONCE at the bounce transition (§14.2), from the same `rec.deliveredAtMs` the
      // receipt derives its `prior` from — the MUST-equal-receipt rule holds by construction, and
      // the read path only ever returns this stored value (never a re-derivation).
      track.prior = prior;
      if (rec.deliveredAtMs !== undefined) track.deliveredAtMs = rec.deliveredAtMs;
      this.mirrorAddressedNotifyStatus(rec.message.id, "bounced");
    }
    const record = this.store.get(rec.message.id);
    if (record) this.autoResolveUndeliverable(record, atMs);
    this.emitBounceReceipt(rec.message, prior, deadSessionId, atMs);
  }

  /**
   * Undeliverable auto-resolution (spec §7): an addressed ask auto-resolves `cancelled`, a task
   * `dismissed`, with attested `response.actor: "system:undeliverable"` — riding the same atomic
   * first-terminal-wins CAS, so it is a harmless no-op when the addressee already resolved (or the
   * message-level expiry already fired).
   */
  private autoResolveUndeliverable(record: MessageRecord, atMs: number): void {
    if (record.message.type === "notify") return;
    // Expiry-vs-undeliverable, same clock (§7/§9.5): if the message-level `expires_at` already fired
    // before the bounce/retention moment, the FIRST terminal is `expired` with `default_on_expire`
    // applied — not `cancelled`/`system:undeliverable`. This is the lazy-clock emulation of the §7
    // timer every sibling path carries (cancel/resolve/resolveAsAgent/expireEntry); the auto-
    // resolution stays a harmless no-op when the expiry already won the CAS.
    if (record.status === "open" && record.expiresAtMs !== null && atMs > record.expiresAtMs) {
      this.applyDefaultExpiry(record, atMs);
      return;
    }
    const res = applyResolution(record, {
      resolution: record.message.type === "ask" ? "cancelled" : "dismissed",
      actor: "system:undeliverable",
      resolved_at: new Date(atMs).toISOString(),
      resolution_id: newResolutionId(),
      ...(record.message.state !== undefined ? { state: record.message.state } : {}),
    });
    if (res.applied) this.emitResponse(record);
  }

  /**
   * Best-effort bounce receipt (spec §8.7.1): delivered only to a LIVE session of the sender — the
   * session-qualified `from` the entry was attested with. A sender that named no session (or whose
   * session is itself terminal) gets nothing; its §8.2 pull remains authoritative. Receipts MUST
   * NOT themselves generate receipts (they carry no track and bounce nowhere).
   */
  private emitBounceReceipt(message: InterAgentMessage, prior: "queued" | "delivered", deadSessionId: string, atMs: number): void {
    const from = Hub.parseAddress(message.from);
    if (!from || from.session === undefined) return;
    const senderSession = this.sessions.get(from.session);
    if (!senderSession || senderSession.session.state !== "active") return;
    const receipt: ReceiptEntry = {
      ma2h_version: MA2H_VERSION,
      type: "receipt",
      id: newReceiptId(),
      in_reply_to: message.id,
      event: "bounced",
      prior,
      at: new Date(atMs).toISOString(),
      session: deadSessionId,
      to: message.from,
    };
    const box = this.mailboxes.get(from.principal) ?? [];
    box.push({
      kind: "receipt",
      receipt,
      ackKey: receipt.id,
      addressedSession: from.session,
      invisibleUntilMs: 0,
      acked: false,
      enqueuedAtMs: atMs,
    });
    this.mailboxes.set(from.principal, box);
  }

  /**
   * Retention sweep (spec §14.2) against the injected clock — the terminals that make "not picked
   * up yet" and "never will be" stop presenting identically:
   *
   * - a QUEUED mailbox entry past retention → `expired` (never delivered), and an addressed
   *   ask/task auto-resolves `system:undeliverable` (§7 — the resolver-facing entry is gone; no
   *   receipt is emitted for expiry, the sender's pull is authoritative);
   * - a DELIVERED-but-unacked entry past retention → `bounced` `prior:"delivered"` (drained, its
   *   claimant gone, never rescued — the exact seen-then-orphaned semantic), receipt's `session`
   *   naming the last claimant;
   * - a resolved ask/task whose response track is short of `delivered-to-agent` at retention →
   *   response track `expired` (the answer was NEVER seen; never rewrites a reached
   *   `delivered-to-agent`);
   * - `response`/`receipt` entries past retention are dropped silently (conveniences over durable
   *   state).
   */
  sweepRetention(nowMs?: number): void {
    const t = nowMs ?? this.now();
    this.settleSessions(t);
    for (const [principal, box] of this.mailboxes) {
      for (const rec of box) {
        if (rec.acked) continue;
        if (t - rec.enqueuedAtMs <= this.retentionMs) continue;
        if (rec.kind === "response" || rec.kind === "receipt") {
          rec.acked = true;
          continue;
        }
        if (rec.deliveredAtMs !== undefined) {
          // Seen-then-orphaned: bounce with prior:"delivered", the receipt naming the last claimant.
          this.bounceEntry(rec, rec.claimedBySession ?? rec.addressedSession ?? "", t);
          continue;
        }
        rec.acked = true;
        if (rec.kind === "directive") {
          this.directiveDeliveries.set(rec.directive.id, { state: "expired" });
          continue;
        }
        const track = this.mailboxTracks.get(rec.message.id);
        if (track && track.state === "queued") {
          track.state = "expired";
          this.mirrorAddressedNotifyStatus(rec.message.id, "expired");
        }
        const record = this.store.get(rec.message.id);
        if (record) this.autoResolveUndeliverable(record, t);
      }
      this.mailboxes.set(
        principal,
        box.filter((r) => !r.acked),
      );
    }
    // Response-track retention (§14.2): a terminal ask/task whose answer was never picked up.
    // Anchored at RESOLUTION time (§8.2 keeps a resolved message pull-available for the full TTL
    // after resolution) — not submission, which would shrink the guaranteed pull window toward zero
    // for an ask that stayed open most of the retention period before being answered.
    for (const [id, record] of this.store) {
      if (record.status === "open" || record.message.type === "notify") continue;
      if (t - (record.resolvedAtMs ?? record.createdAtMs) <= this.retentionMs) continue;
      const track = this.deliveries.get(id);
      if (track === undefined || (track.state !== "delivered-to-agent" && track.state !== "acknowledged")) {
        this.deliveries.set(id, { state: "expired" });
      }
    }
  }
}
