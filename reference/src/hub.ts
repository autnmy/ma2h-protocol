// Minimal in-memory reference Hub — spec §7, §8, §9.1/§9.2.
//
// Not a production Hub (no persistence, no real HTTP, no SSRF egress). It exists
// to demonstrate the protocol end-to-end and to host the lifecycle + signing
// behaviour the spec requires. "Push delivery" is modelled as an in-process
// `onDeliver` callback rather than an HTTP POST.

import { newDirectiveId, newJti, newMessageId, newResolutionId } from "./ids.js";
import { applyResolution, type MessageRecord } from "./lifecycle.js";
import {
  buildInboundSignedContext,
  buildSignedContext,
  computeDirectivePayloadSha256,
  computePayloadSha256,
  signInbound,
  signResponse,
} from "./signing.js";
import { validateInboundMessage, validateMessage } from "./envelope.js";
import type {
  A2hMessage,
  A2hResponse,
  Actor,
  AskMessage,
  Callback,
  DirectiveFrom,
  DirectiveTo,
  InboundDelivery,
  InboundDirective,
  JsonObject,
  Part,
  Priority,
  Resolution,
  Status,
  SubmitAck,
  TaskMessage,
} from "./types.js";

/** Highest version this reference Hub implements (spec §10) — major 0, up to minor 4. */
const HUB_VERSION = "0.4";
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
}

/** A directive resting in a mailbox (spec §8.7, §13). */
interface DirectiveRecord {
  directive: InboundDirective;
  /** Hidden from drains until now >= this (visibility window). 0 = immediately deliverable. */
  invisibleUntilMs: number;
  acked: boolean;
}

export interface ResolveInput {
  actor: Actor;
  resolution: Resolution;
  value?: string | JsonObject;
  comment?: string;
}

export type GetResult = (A2hMessage & { id: string; status: Status; response?: A2hResponse }) | null;

export class Hub {
  private readonly store = new Map<string, MessageRecord>();
  /** Per-`agent.id` mailbox of pending directives (spec §8.7, §13). FIFO = array order. */
  private readonly mailboxes = new Map<string, DirectiveRecord[]>();
  private readonly signingKey: string;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly onDeliver: ((push: DeliveredPush) => void) | undefined;
  private readonly visibilityMs: number;

  constructor(opts: HubOptions) {
    this.signingKey = opts.signingKey;
    this.baseUrl = opts.baseUrl ?? "https://hub.example";
    this.now = opts.now ?? ((): number => Date.now());
    this.onDeliver = opts.onDeliver;
    this.visibilityMs = (opts.visibilityTimeoutSeconds ?? 60) * 1000;
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
        `ma2h_version "${raw}": major ${nonZeroMajor[1]} is not supported (this Hub implements ${HUB_VERSION}; §10)`,
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

  submit(message: A2hMessage): SubmitAck {
    this.negotiateVersion(message);
    const v = validateMessage(message);
    if (!v.valid) throw new HubError("validation_error", `invalid message: ${v.errors.join("; ")}`);
    const id = newMessageId();
    const isNotify = message.type === "notify";
    const record: MessageRecord = {
      id,
      message,
      status: isNotify ? "delivered" : "open",
      createdAtMs: this.now(),
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
   * Poll a message (§8.2). `principal` is the authenticated caller's `agent.id` and is
   * REQUIRED: there is no unauthenticated poll in the protocol, so the submitter-binding
   * (§9.1) cannot be bypassed by omitting it. To a non-submitting principal the message is
   * invisible (`null`), indistinguishable from an unknown id — the same id-enumeration guard
   * `cancel()` applies. The Hub reads its own internal state directly off `store`, never here.
   */
  get(id: string, principal: string): GetResult {
    const r = this.store.get(id);
    if (!r) return null;
    if (r.message.agent.id !== principal) return null;
    return { ...r.message, id: r.id, status: r.status, ...(r.response ? { response: r.response } : {}) };
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
    this.deliver(record);
    return record.response as A2hResponse;
  }

  /** Human/inbox resolution. Enforces fail-closed authz + expiry-vs-answer precedence. */
  resolve(id: string, input: ResolveInput, nowMs?: number): A2hResponse {
    const record = this.store.get(id);
    if (!record) throw new HubError("not_found", `unknown message: ${id}`);
    if (record.message.type === "notify") {
      throw new HubError("validation_error", "notify is not resolvable");
    }
    if (record.status !== "open") return record.response as A2hResponse; // first-terminal-wins

    const t = nowMs ?? this.now();
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
      ...(record.message.state !== undefined ? { state: record.message.state } : {}),
    });
    if (res.applied) this.deliver(record);
    return record.response as A2hResponse;
  }

  /** Expiry sweep for one message. Returns the Response if it expired now, else null. */
  expire(id: string, nowMs?: number): A2hResponse | null {
    const record = this.store.get(id);
    if (!record) return null;
    const t = nowMs ?? this.now();
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
    this.deliver(record);
    return record.response as A2hResponse;
  }

  private assertAuthorized(message: AskMessage | TaskMessage, actor: Actor): void {
    const allowed =
      message.type === "ask" ? message.request.allowed_resolvers : message.action.allowed_resolvers;
    const submitter: Actor = `agent:${message.agent.id}`;
    const permitted = allowed ? allowed.includes(actor) : actor === submitter; // fail-closed default
    if (!permitted) {
      throw new HubError("not_authorized", `resolver ${actor} is not permitted for this message`);
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
  }

  // ---- Inbound leg — human → agent directives (spec §8.7, §13) ----

  /** The mailbox key (`agent.id`) for an `agent:<id>` address. */
  private static mailboxKey(to: DirectiveTo): string {
    return to.slice("agent:".length);
  }

  /**
   * Enqueue a human→agent directive (spec §13). The Hub attests `from` (here supplied by the trusted
   * caller standing in for the operator session), assigns the `id`, and appends to the addressee's
   * durable, FIFO mailbox. Returns the assigned id. No Response is ever emitted for a directive (§13.3).
   */
  sendDirective(input: SendDirectiveInput): { id: string } {
    const id = newDirectiveId();
    const directive: InboundDirective = {
      ma2h_version: HUB_VERSION,
      type: "directive",
      id,
      from: input.from,
      to: input.to,
      created_at: new Date(this.now()).toISOString(),
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    };
    const v = validateInboundMessage(directive);
    if (!v.valid) throw new HubError("validation_error", `invalid directive: ${v.errors.join("; ")}`);
    const key = Hub.mailboxKey(input.to);
    const box = this.mailboxes.get(key) ?? [];
    box.push({ directive, invisibleUntilMs: 0, acked: false });
    this.mailboxes.set(key, box);
    // Best-effort webhook push mirrors §8.3; modelled via onDeliver is out of scope here — pull is the
    // source of truth (§8.7), which the reference exercises. Production Hubs add the push per §13.2.
    return { id };
  }

  /**
   * Drain up to `max` pending directives for the authenticated `principal` (its `agent.id` — the mailbox
   * key; §9.1 binds the mailbox to the credential, never a request field). FIFO on first delivery; each
   * returned directive is re-signed with a fresh `t`/`jti` (§9.7 per-delivery signing) and marked
   * in-flight for the visibility window, so an un-acked directive is redelivered later (at-least-once).
   */
  drainInbox(principal: string, opts?: { max?: number; now?: number }): InboundDelivery[] {
    const box = this.mailboxes.get(principal);
    if (!box) return [];
    const t = opts?.now ?? this.now();
    // Coerce `max` defensively: a non-finite value (e.g. a NaN from parsing `?max=abc`) MUST NOT
    // silently disable the cap — `out.length >= NaN` is always false, which would drain the whole
    // mailbox. Fall back to unbounded only for an explicitly absent max.
    const rawMax = opts?.max;
    const max = rawMax === undefined ? Number.POSITIVE_INFINITY : Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : 0;
    const out: InboundDelivery[] = [];
    for (const rec of box) {
      if (out.length >= max) break;
      if (rec.acked) continue;
      if (this.expireDirective(rec, t)) continue;
      if (rec.invisibleUntilMs > t) continue;
      rec.invisibleUntilMs = t + this.visibilityMs;
      out.push({ directive: rec.directive, signature: this.signDirective(rec.directive, t) });
    }
    return out;
  }

  /**
   * Consume (ack) processed directives for `principal` (spec §8.7). Removes matching records from the
   * caller's OWN mailbox only; ids not in it are no-ops (and reveal nothing about other mailboxes).
   * Idempotent. Returns how many were acked by this call.
   */
  ackInbox(principal: string, ids: string[]): { acked: number } {
    const box = this.mailboxes.get(principal);
    if (!box) return { acked: 0 };
    const wanted = new Set(ids);
    let acked = 0;
    for (const rec of box) {
      if (!rec.acked && wanted.has(rec.directive.id)) {
        rec.acked = true;
        acked++;
      }
    }
    // Compact acked records out of the mailbox.
    this.mailboxes.set(
      principal,
      box.filter((r) => !r.acked),
    );
    return { acked };
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

  /** Mark a directive acked (dropped) if past its `expires_at` (spec §13.3). Returns true if expired. */
  private expireDirective(rec: DirectiveRecord, nowMs: number): boolean {
    if (rec.directive.expires_at === undefined) return false;
    if (nowMs <= Date.parse(rec.directive.expires_at)) return false;
    rec.acked = true; // dropped: never delivered again (no Response — §13.3)
    return true;
  }
}
