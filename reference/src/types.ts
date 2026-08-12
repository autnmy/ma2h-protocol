// MA2H domain types — strongly typed to spec/v0.3.md and schema/v0.3/*.
// The discriminated unions mirror the JSON Schema `oneOf` branches exactly, so
// the type system enforces the same shape rules the schemas do.

/** Protocol version string, e.g. "0.3". */
export type A2hVersion = `0.${number}`;

export type MessageType = "notify" | "ask" | "task";
export type Priority = "low" | "normal" | "high" | "urgent";
export type Runtime = "github-actions" | "cli" | "cloud" | "desktop" | "openclaw" | "other";

/** Recursive JSON value — for opaque `state` and JCS canonicalization. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AgentDescriptor {
  id: string;
  run_id: string;
  runtime: Runtime;
  /**
   * v0.5, optional: this invocation's registered session (`sess_`, spec §4.1/§16). Foreign/unknown
   * → 422; own-but-terminal → 410. When present, the Caller's mailbox for Response delivery is this
   * session (§6) and the Hub-attested `from` on the delivered form is session-qualified (§8.7).
   */
  session?: string;
  project?: string;
  labels?: Record<string, string>;
}

export type Part =
  | { kind: "text"; text: string; metadata?: JsonObject }
  | { kind: "data"; data: JsonObject; metadata?: JsonObject }
  | { kind: "file"; file: { uri: string; name?: string; mime_type?: string }; metadata?: JsonObject };

/** Hub-attested resolver identity: `<type>:<id>` (spec §9.1). */
export type Actor = `${"human" | "agent" | "system"}:${string}`;

/**
 * An agent destination address (v0.5, spec §4): `agent:<id>` (principal) or
 * `agent:<id>#<session>` (session-qualified). Used by the envelope `to`, the Hub-attested entry
 * `from`, and the §9.8 signed-context `to` bindings.
 */
export type AgentAddress = `agent:${string}`;

export interface ResponseOption {
  value: string;
  label: string;
  description?: string;
}

export interface Permissions {
  allow_accept?: boolean;
  allow_edit?: boolean;
  allow_respond?: boolean;
  allow_ignore?: boolean;
}

/** Callback auth, discriminated by scheme (secret_ref↔hmac, token_ref↔bearer/apikey). */
export type CallbackAuth =
  | { scheme: "hmac"; secret_ref: string }
  | { scheme: "bearer"; token_ref: string }
  | { scheme: "apikey"; token_ref: string };

/** Callback, discriminated by mode (push requires url). */
export type Callback = { mode: "push"; url: string; auth?: CallbackAuth } | { mode: "pull" };

export type RequestMode = "select" | "input" | "confirm";

/** Flat JSON Schema for mode=input; properties MAY carry `x-ma2h-sensitive`. */
export type InputSchema = JsonObject;

export interface AskRequest {
  mode: RequestMode;
  options?: ResponseOption[];
  schema?: InputSchema;
  permissions?: Permissions;
  default_on_expire?: string | JsonObject | null;
  allowed_resolvers?: Actor[];
  callback?: Callback;
}

export interface TaskAction {
  instructions: string;
  checklist?: { text: string; done?: boolean }[];
  verification?: string;
  allowed_resolvers?: Actor[];
  callback?: Callback;
}

interface BaseEnvelope {
  ma2h_version: A2hVersion;
  created_at: string;
  agent: AgentDescriptor;
  /**
   * v0.5, optional destination (spec §4): `agent:<id>` (principal-addressed) or
   * `agent:<id>#<session>` (session-addressed). Absent = the human inbox, unchanged; present routes
   * the message to the destination's §8.7 mailbox as a `message` entry. Within `to`, the FIRST `#`
   * terminates the agent-id segment and the session segment must match `^sess_` (§4 grammar).
   */
  to?: AgentAddress;
  title: string;
  body?: string;
  priority?: Priority;
  tags?: string[];
  context?: Part[];
  /** Opaque, agent-owned, agent-integrity-sealed resume blob (spec §9.3). */
  state?: JsonObject;
  /** Opaque correlation label; never a dedup key (spec §4, KTD1). */
  client_ref?: string;
  expires_at?: string;
  sensitive?: boolean;
}

export interface NotifyMessage extends BaseEnvelope {
  type: "notify";
  /** MAY for notify. */
  idempotency_key?: string;
}
export interface AskMessage extends BaseEnvelope {
  type: "ask";
  /** REQUIRED for ask (KTD1b). */
  idempotency_key: string;
  request: AskRequest;
}
export interface TaskMessage extends BaseEnvelope {
  type: "task";
  /** REQUIRED for task (KTD1b). */
  idempotency_key: string;
  action: TaskAction;
}
/** The agent→Hub message envelope, discriminated on `type`. */
export type A2hMessage = NotifyMessage | AskMessage | TaskMessage;

// ---- Lifecycle (spec §7) ----
export type AskResolution = "answered" | "declined" | "cancelled" | "expired";
export type TaskResolution = "completed" | "dismissed" | "expired";
export type Resolution = AskResolution | TaskResolution;
/**
 * Full lifecycle status value space (spec §7, §8). v0.5 adds `queued`/`bounced`/`acknowledged` for
 * ADDRESSED messages: an addressed notify's lifecycle IS the §14.2 delivery track; an addressed
 * ask/task keeps the §7 resolution machinery here (mailbox states live on the `mailbox` object).
 */
export type Status = "open" | "delivered" | "queued" | "bounced" | "acknowledged" | Resolution;

// ---- Response (spec §6) ----
export interface ResponseAgent {
  id: string;
  run_id: string;
}

export interface ResponseDetail {
  /** ask only: chosen option value (string) or the input object. Absent for task. */
  value?: string | JsonObject;
  edited?: boolean;
  actor: Actor;
  resolved_at: string;
  comment?: string;
  /**
   * Task resolutions only (v0.5, spec §6/§8.8): the final §5.3 checklist state, carried from the
   * resolve binding into the Response. Each item states its doneness on a >= 0.5 Response.
   */
  checklist?: { text: string; done: boolean }[];
}

export interface A2hResponse {
  ma2h_version: A2hVersion;
  in_reply_to: string;
  resolution_id: string;
  agent: ResponseAgent;
  resolution: Resolution;
  defaulted?: boolean;
  response?: ResponseDetail;
  /** Opaque agent blob, round-tripped verbatim. UNTRUSTED until verified (spec §9.3). */
  state?: JsonObject;
}

/** The exact fields bound by the detached Response signature (spec §9.2). */
export interface SignedContext {
  ma2h_version: A2hVersion;
  callback_url: string;
  id: string;
  in_reply_to: string;
  jti: string;
  /** Lowercase-hex SHA-256 of the canonical response payload (v0.3; spec §9.2). */
  payload_sha256: string;
  resolution: Resolution;
  resolution_id: string;
  resolved_at: string;
  t: string;
}

// ---- Inbound leg — human → agent directives (spec §13, v0.4) ----

/** Hub-attested directive author: `human:<id>` in v0.4 (`system:<id>` reserved). */
export type DirectiveFrom = `${"human" | "system"}:${string}`;
/** Addressed agent: `agent:<id>` — the mailbox routing key. */
export type DirectiveTo = `agent:${string}`;

/**
 * The delivered human→agent directive (spec §13.1). `id`/`from` are Hub-assigned/attested; the agent
 * validates against inbound-message.schema.json, verifies the §9.7 signature, and dedups on `id`.
 */
export interface InboundDirective {
  ma2h_version: A2hVersion;
  type: "directive";
  id: string;
  from: DirectiveFrom;
  to: DirectiveTo;
  created_at: string;
  title: string;
  body?: string;
  priority?: Priority;
  tags?: string[];
  context?: Part[];
  expires_at?: string;
  sensitive?: boolean;
}

/** The exact fields bound by the detached directive signature (spec §9.7). */
export interface InboundSignedContext {
  from: DirectiveFrom;
  id: string;
  jti: string;
  ma2h_version: A2hVersion;
  /** Lowercase-hex SHA-256 of JCS({ directive: <content> }) (spec §9.7). */
  payload_sha256: string;
  t: string;
  to: DirectiveTo;
}

/** One drained (or pushed) directive plus its `MA2H-Signature` header (spec §8.7). */
export interface InboundDelivery {
  directive: InboundDirective;
  signature: string;
}

// ---- Transport bodies (spec §8) ----

/**
 * The destination's §15 reachability at send time, REQUIRED on every addressed-submit ack (v0.5,
 * spec §8.1) — the sender's misroute detector. Exactly `{ state: "unknown" }` (no `last_seen`)
 * when the sender lacks visibility (§16 policy).
 */
export interface DestinationSnapshot {
  state: PresenceState;
  last_seen?: string;
}

export interface SubmitAck {
  id: string;
  /**
   * The verb's OWNING-track status (spec §8.1). At first accept: `open` (any ask/task),
   * `delivered` (human-inbox notify), or `queued` (ADDRESSED notify — its lifecycle IS the §14.2
   * delivery track; asserting `delivered` at accept would be the false belief v0.5 bans).
   */
  status: "open" | "delivered" | "queued";
  poll_url: string;
  review_url?: string;
  /** Present on every ADDRESSED submit ack (v0.5, spec §8.1); absent on the human-inbox path. */
  destination?: DestinationSnapshot;
}

// ---- Acknowledgment / receipt (spec §14, v0.4) ----

/** A one-shot terminal receipt (spec §14). Cross-cutting; the Hub attests `by`. */
export interface Ack {
  ma2h_version: A2hVersion;
  type: "ack";
  in_reply_to: string;
  by: Actor;
  acked_at: string;
  note?: string;
  resolution_id?: string;
}

/** The fields bound by the pushed-ack signature (spec §14.4). */
export interface AckSignedContext {
  ack_sha256: string;
  by: Actor;
  in_reply_to: string;
  jti: string;
  ma2h_version: A2hVersion;
  t: string;
}

/**
 * The additive receipt track surfaced on the GET body (spec §14.2), orthogonal to `resolution`.
 * `queued`/`delivered`/`expired`/`bounced` are mailbox states (directives and v0.5 `message`
 * entries, §13/§8.7); `delivered-to-agent`/`acknowledged` are the response-leg states (§6);
 * `acknowledged` is shared. v0.5 adds the terminal `bounced` (destination session went terminal
 * before ack, spec §14.2).
 */
export type DeliveryState =
  | "queued"
  | "delivered"
  | "expired"
  | "bounced"
  | "delivered-to-agent"
  | "acknowledged";
export interface Delivery {
  state: DeliveryState;
  delivered_at?: string;
  acknowledged_at?: string;
  ack?: Ack;
}

/**
 * The response-leg receipt on the `GET /v1/messages/{id}` body (spec §14.2) — only the response-leg
 * states, matching `get-message.schema.json` (the mailbox states live on the `mailbox` object).
 * v0.5 adds the terminal `expired`: message retention passed short of `delivered-to-agent` — the
 * answer was NEVER seen (never rewrites a reached `delivered-to-agent`).
 */
export type ResponseDeliveryState = "delivered-to-agent" | "acknowledged" | "expired";
export interface ResponseDelivery {
  state: ResponseDeliveryState;
  delivered_at?: string;
  acknowledged_at?: string;
  ack?: Ack;
}

/**
 * The outbound MAILBOX track of an ADDRESSED message on the sender's authoritative §8.2 pull (v0.5,
 * spec §14.2): `queued → delivered → acknowledged`, or terminal `bounced`/`expired` — did the
 * ADDRESSEE see it. On `bounced`, a present `delivered_at` means seen-then-orphaned; absent means
 * never seen (the receipt `prior` distinction, §8.7.1). A track `expired` MUST mean never delivered.
 */
export type MailboxState = "queued" | "delivered" | "acknowledged" | "bounced" | "expired";
export interface MailboxTrack {
  state: MailboxState;
  delivered_at?: string;
  acknowledged_at?: string;
}

// ---- Presence / "listening" (spec §15, v0.4) ----

export type PresenceState = "online" | "offline" | "unknown";
export interface Presence {
  agent_id: string;
  state: PresenceState;
  last_seen?: string;
  /** Required (spec §15.3 / presence.schema.json) — clients need the window to interpret the state. */
  freshness_seconds: number;
}

export type GetMessageBody = A2hMessage & {
  id: string;
  status: Status;
  response?: A2hResponse;
  delivery?: ResponseDelivery;
  /** v0.5: the sender-authoritative outbound mailbox track — present only for ADDRESSED messages. */
  mailbox?: MailboxTrack;
};

export interface Capability {
  ma2h_version: A2hVersion;
  max_body_bytes?: number;
  max_part_bytes?: number;
  max_context_parts?: number;
  auth_schemes?: Array<"bearer" | "apikey">;
  callback_auth_schemes?: Array<"hmac" | "bearer" | "apikey">;
  signature_algs?: Array<"hmac-sha256" | "ed25519">;
  rate_limit?: { requests_per_minute?: number; inbox_depth?: number };
  retention_days?: number;
  replay_window_seconds?: number;
  /** Human→agent inbound leg (spec §8.0, §13). Absent on a v0.3-only Hub. */
  inbound?: {
    enabled: boolean;
    poll_url?: string;
    ack_url?: string;
    max_batch?: number;
    visibility_timeout_seconds?: number;
    retention_days?: number;
    signature_algs?: Array<"hmac-sha256" | "ed25519">;
    webhook_supported?: boolean;
  };
  /** Acknowledgment/receipt primitive (spec §8.0, §14). */
  ack?: { enabled: boolean; signature_algs?: Array<"hmac-sha256" | "ed25519"> };
  /** Presence/'listening' signal (spec §8.0, §15). */
  presence?: { enabled: boolean; freshness_seconds?: number };
  /** Session primitive (v0.5, spec §8.0, §16). REQUIRED of a Hub offering the inter-agent leg. */
  sessions?: {
    enabled: boolean;
    min_ttl_seconds?: number;
    max_ttl_seconds?: number;
    max_live_per_agent?: number;
    agent_list_visibility?: boolean;
    terminal_retention_seconds?: number;
  };
  /** Inter-agent leg (v0.5, spec §8.0). Account-opt-in: `enabled` defaults false. */
  inter_agent?: {
    enabled: boolean;
    entry_kinds?: Array<"message" | "response" | "receipt">;
    sender_allowlists?: boolean;
  };
}

// ---- Sessions (spec §16, v0.5) ----

/** `active → closed` (explicit DELETE) or `active → expired` (lease lapse). Terminal = immutable. */
export type SessionState = "active" | "closed" | "expired";

/** The session RESOURCE as the Hub returns it (spec §16.1, session.schema.json). */
export interface Session {
  /** Hub-minted (`^sess_`). Not a secret and not a credential (spec §16). */
  id: string;
  agent_id: string;
  state: SessionState;
  created_at: string;
  /** Current lease expiry (Hub clock). Renewed only by client-originated activity (spec §16.2). */
  expires_at: string;
  /** Latest client-originated renewal event (spec §15.1 per-session presence). */
  last_seen?: string;
  /** The lease TTL in effect (requested value clamped to the advertised bounds). */
  ttl_seconds?: number;
  closed_at?: string;
  run_id?: string;
  label?: string;
  kind?: string;
  project?: string;
  labels?: Record<string, string>;
}

/** `POST /v1/sessions` request body (spec §16.1). All fields optional. */
export interface SessionRegisterRequest {
  run_id?: string;
  label?: string;
  kind?: string;
  project?: string;
  labels?: Record<string, string>;
  ttl_seconds?: number;
}

// ---- v0.5 inter-agent entry kinds (spec §8.7.1) ----

/**
 * The DELIVERED form of an addressed §4 envelope (spec §8.7): the submitted notify/ask/task plus
 * Hub-assigned `id` and Hub-attested `from` (session-qualified when the submit carried
 * `agent.session`). The Hub strips submitter-side machinery before delivery (`state`, `client_ref`,
 * any `request.callback`/`action.callback`); `idempotency_key` is delivered (inert). The `agent`
 * descriptor is delivered but ADVISORY — the attested identity is `from`.
 */
export type InterAgentMessage = A2hMessage & {
  id: string;
  from: AgentAddress;
  to: AgentAddress;
};

/**
 * A Hub-originated delivery-status notification to a SENDER (spec §8.7.1, §14.2); v0.5 uses it for
 * the bounce. Best-effort, at-most-once-meaningful — the recipient dedups on `(in_reply_to, event)`
 * — delivered only to live sessions of the sender; MUST NOT itself generate receipts.
 */
export interface ReceiptEntry {
  ma2h_version: A2hVersion;
  type: "receipt";
  /** Hub-assigned `rcpt_` id — this entry's ack key (spec §8.7.1), bound inside the §9.8 digest. */
  id: string;
  /** The affected entry/message id — with `event`, the dedup key. */
  in_reply_to: string;
  event: "bounced";
  /** `queued` = never seen; `delivered` = drained-but-unacked when the session died (§14.2). */
  prior: "queued" | "delivered";
  at: string;
  /** The terminal destination session whose death bounced the entry. */
  session: string;
  /** The sender session this receipt is delivered to; bound in the §9.8 context. */
  to: AgentAddress;
}

/**
 * One drained (or streamed) mailbox entry plus its `MA2H-Signature` header (spec §8.7.1) — the
 * v0.5 union. A session-less drain only ever yields the `directive` member (v0.4 shape,
 * back-compat by construction); the v0.5 kinds are delivered only to session-presenting drains.
 */
export type InboxEntryDelivery =
  | InboundDelivery
  | { message: InterAgentMessage; signature: string }
  | { response: A2hResponse; signature: string }
  | { receipt: ReceiptEntry; signature: string };

// ---- The three §9.8 signed contexts (v0.5) ----

/** `message` entry context — the inter-agent mirror of §9.7, same key set (spec §9.8). */
export interface MessageEntrySignedContext {
  from: AgentAddress;
  id: string;
  jti: string;
  ma2h_version: A2hVersion;
  /** Lowercase-hex SHA-256 of JCS({ message: <present content fields> }) (spec §9.8). */
  payload_sha256: string;
  t: string;
  to: AgentAddress;
}

/**
 * `response` entry context — §9.2's key set with the mailbox destination (`to`) in place of
 * `callback_url`, and the IDENTICAL payload digest (spec §9.8). `id` always equals `in_reply_to`
 * (both name the message record); `resolved_at` is JSON `null` when a task Response has no detail.
 */
export interface ResponseEntrySignedContext {
  id: string;
  in_reply_to: string;
  jti: string;
  ma2h_version: A2hVersion;
  payload_sha256: string;
  resolution: Resolution;
  resolution_id: string;
  resolved_at: string | null;
  t: string;
  to: AgentAddress;
}

/** `receipt` entry context — the §14.4 ack pattern (spec §9.8). */
export interface ReceiptSignedContext {
  in_reply_to: string;
  jti: string;
  ma2h_version: A2hVersion;
  /** SHA-256 of JCS of the fixed six-key wrapper { at, event, id, in_reply_to, prior, session }. */
  receipt_sha256: string;
  t: string;
  to: AgentAddress;
}

export interface A2hError {
  error: { code: string; message: string };
}
