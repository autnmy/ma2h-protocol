// A2H domain types — strongly typed to spec/v0.3.md and schema/v0.3/*.
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
  project?: string;
  labels?: Record<string, string>;
}

export type Part =
  | { kind: "text"; text: string; metadata?: JsonObject }
  | { kind: "data"; data: JsonObject; metadata?: JsonObject }
  | { kind: "file"; file: { uri: string; name?: string; mime_type?: string }; metadata?: JsonObject };

/** Hub-attested resolver identity: `<type>:<id>` (spec §9.1). */
export type Actor = `${"human" | "agent" | "system"}:${string}`;

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

/** Flat JSON Schema for mode=input; properties MAY carry `x-a2h-sensitive`. */
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
  a2h_version: A2hVersion;
  created_at: string;
  agent: AgentDescriptor;
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
/** Full lifecycle status value space (spec §7, §8). */
export type Status = "open" | "delivered" | Resolution;

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
}

export interface A2hResponse {
  a2h_version: A2hVersion;
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
  a2h_version: A2hVersion;
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

// ---- Transport bodies (spec §8) ----
export interface SubmitAck {
  id: string;
  status: "open" | "delivered";
  poll_url: string;
  review_url?: string;
}

export type GetMessageBody = A2hMessage & { id: string; status: Status; response?: A2hResponse };

export interface Capability {
  a2h_version: A2hVersion;
  max_body_bytes?: number;
  max_part_bytes?: number;
  max_context_parts?: number;
  auth_schemes?: Array<"bearer" | "apikey">;
  callback_auth_schemes?: Array<"hmac" | "bearer" | "apikey">;
  signature_algs?: Array<"hmac-sha256" | "ed25519">;
  rate_limit?: { requests_per_minute?: number; inbox_depth?: number };
  retention_days?: number;
  replay_window_seconds?: number;
}

export interface A2hError {
  error: { code: string; message: string };
}
