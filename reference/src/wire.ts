// The KEYLESS half of the vendorable client layer (issue #45) — client-side wire mechanics a
// consumer can use while holding no signing key: the canonical envelope builders for the §4
// submit surface, the client-side version-stamp rule (§10), the §8.1 submit-ack validation with
// the addressed-misroute detector, the per-type status tables and poll checks (§7/§8.2/§14.2),
// the drain-batch shape guard and §8.7.1 entry-kind taxonomy, the strip-duty field rules
// (§10/§13.4 — the keep-lists and `validateKnownFields`), and the §8.5 error reading
// (`effectiveCode` + the six-class semantic classification).
//
// VENDORABLE COVENANT (issue #45; spec §4, §7, §8.1, §8.5, §8.7.1, §10, §13.4, §14.2): downstream
// consumers vendor this file byte-for-byte and import it per-file (subpath exports), so PLACEMENT
// IS API — no renames and no symbol relocation after landing. This module must introduce no
// `new HubError` sites: `test/errors.test.ts` scans `src/` flat and floors the emitter count, and
// the keyless side only ever READS Hub errors — it never mints them. It also stays free of the
// keyed dependency tree (no signing/state-seal imports), so a keyless HTTP consumer can vendor it
// without dragging in the `Agent` embodiment.

import { randomUUID } from "node:crypto";

import {
  baseCodeForStatus,
  isKnownHubErrorCode,
  type HubTouchpoint,
  type KnownHubErrorCode,
} from "./errors.js";
import { validateMessage, validateV05, type ValidationResult } from "./envelope.js";
import type {
  A2hMessage,
  A2hVersion,
  AgentAddress,
  AgentDescriptor,
  AskMessage,
  AskRequest,
  DestinationSnapshot,
  InboundDirective,
  InboxEntryDelivery,
  InterAgentMessage,
  JsonObject,
  MessageType,
  NotifyMessage,
  Part,
  Priority,
  Resolution,
  Status,
  SubmitAck,
  TaskAction,
  TaskMessage,
} from "./types.js";

// ---- Idempotency keys (spec §4, KTD1b) ----

/**
 * Mint a fresh `idempotency_key` (spec §4; dedup scope `(agent.id, idempotency_key)`). The
 * `idem_` prefix is the downstream consumers' existing convention (nothing in the schemas
 * constrains key format); `randomUUID` provides 122 bits of entropy, matching `ids.ts`.
 *
 * MINT-ONCE-REUSE (KTD1b): mint ONE key per logical ask/task and pass the SAME key on every
 * retry of that submit — that is what makes the §8.1 idempotent-replay path reachable. The
 * builders never mint silently: a fresh key per attempt would defeat dedup, so the caller owns
 * the key's lifetime and `buildAsk`/`buildTask` require it as input.
 */
export const newIdempotencyKey = (): string => `idem_${randomUUID()}`;

// ---- The client-side version-stamp rule (spec §10; the oh-hai#712 twin) ----

/**
 * The envelope fields the version rule (and its feature predicates) reads — structurally
 * satisfied by any `A2hMessage` or builder input, so consumers can classify envelopes they did
 * not build.
 */
export interface VersionFeatureProbe {
  to?: AgentAddress;
  agent: Pick<AgentDescriptor, "session">;
  /** The ask surface, when present — read for session-qualified `allowed_resolvers` entries. */
  request?: Pick<AskRequest, "allowed_resolvers">;
  /** The task surface, when present — read for session-qualified `allowed_resolvers` entries. */
  action?: Pick<TaskAction, "allowed_resolvers">;
}

/**
 * Does this envelope use v0.5 INTER-AGENT ADDRESSING? True iff `to` is present (spec §4) or
 * `agent.session` is present (spec §4.1). Either feature commits the envelope to minor >= 5
 * (message.schema.json's root conditional enforces the same rule server-side).
 *
 * VOCABULARY NOTE: this predicate is deliberately BROADER than §8.1's strict "addressed" sense
 * (keyed on `to` alone) — `agent.session` without `to` still submits to the HUMAN inbox, yet
 * commits the envelope to the inter-agent leg's minor. `SubmitContext.addressed` /
 * `PollExpectation.addressed` carry the strict §8.1 sense and must never be derived from this.
 */
export function usesInterAgentAddressing(envelope: VersionFeatureProbe): boolean {
  return envelope.to !== undefined || envelope.agent.session !== undefined;
}

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
  // The §4 grammar requires `sess_` plus at least one character — a bare `sess_` suffix is
  // malformed, and this newly-public parser must enforce that itself: a downstream consumer
  // using it for routing/addressee checks without a preceding schema pass would otherwise treat
  // a malformed address as session-qualified (codex, PR #51, rounds 3-4).
  if (principal.length === 0 || !/^sess_.+$/.test(session)) return null;
  return { principal, session };
}

/**
 * Does this envelope's `request`/`action` name a SESSION-QUALIFIED agent-form resolver — an
 * `agent:` `allowed_resolvers` entry containing `#` (the §4 address grammar's session qualifier)?
 * Session-qualified resolver matching exists only at minor >= 5 (spec §9.1): a pre-0.5 registry
 * validates such an entry under the legacy `^(human|agent|system):.+$` pattern, but a pre-0.5 Hub
 * matches resolvers EXACTLY, so the entry could never match an attested actor — the message would
 * be accepted yet unresolvable. Carrying one therefore commits the envelope to minor >= 5.
 */
export function usesSessionQualifiedResolvers(envelope: VersionFeatureProbe): boolean {
  const resolvers = [
    ...(envelope.request?.allowed_resolvers ?? []),
    ...(envelope.action?.allowed_resolvers ?? []),
  ];
  // Only a syntactically VALID v0.5 session qualifier lifts the version, read by the ONE §4
  // grammar (`splitAddress`: first-`#` split, suffix `sess_` + 1+ chars). A legacy hash-bearing
  // principal (`agent:legacy#worker`) — or a multi-hash literal whose LATER fragment merely looks
  // session-shaped (`agent:legacy#worker#sess_x`) — is a valid pre-0.5 exact-literal resolver;
  // lifting on it would stamp 0.5 and then fail the builder's own self-validation, making a
  // legitimate human-inbox envelope unbuildable (codex, PR #51, rounds 3-4).
  return resolvers.some((actor) => splitAddress(actor)?.session !== undefined);
}

/**
 * The BASE arm of the version-stamp rule (spec §10): the lowest minor a plain human-inbox
 * notify/ask/task requires. Minor 3 is the §9.2 payload-binding floor — the oldest wire shape
 * whose pushed Response signature a conformant client verifies — and every field the builders
 * emit on a non-addressed envelope already existed at 0.3.
 */
export const WIRE_BASE_VERSION = "0.3" satisfies A2hVersion;

/**
 * The feature → minimum-minor table (spec §10): each row names an envelope FEATURE, the lowest
 * `ma2h_version` that admits it, and the predicate that detects it. THE one definition of the
 * stamp rule's non-base arms — `wireVersionFor` derives from it, and a v0.6 feature generalizes
 * this by ADDING A ROW (predicate + `"0.6"` minimum), never by touching existing rows.
 */
export const WIRE_FEATURES = Object.freeze({
  /** `to` and/or `agent.session` — the v0.5 inter-agent addressing surface (spec §4, §4.1). */
  interAgentEnvelope: Object.freeze({ minimum: "0.5", present: usesInterAgentAddressing } as const),
  /** A session-qualified agent-form `allowed_resolvers` entry (spec §4 grammar, §9.1 matching). */
  sessionQualifiedResolvers: Object.freeze({
    minimum: "0.5",
    present: usesSessionQualifiedResolvers,
  } as const),
}) satisfies Record<
  string,
  { minimum: A2hVersion; present: (envelope: VersionFeatureProbe) => boolean }
>;

/** A feature the stamp rule knows — a row of `WIRE_FEATURES`. */
export type WireFeature = keyof typeof WIRE_FEATURES;

/** The minor of a canonical `0.x` version string. */
const minorOf = (version: A2hVersion): number => Number(version.slice("0.".length));

/**
 * The canonical version-stamp rule (spec §10): the LOWEST minor the envelope's features require —
 * `WIRE_BASE_VERSION` lifted to each present feature's `WIRE_FEATURES` minimum. Today that means
 * `"0.3"` for a plain envelope and `"0.5"` for one carrying any inter-agent-leg feature.
 *
 * `MA2H_VERSION` is deliberately NOT an input. Lowest-minor-required is a STATIC property of the
 * features an envelope carries, not of the version this implementation currently speaks: coupling
 * a feature arm to `MA2H_VERSION` would silently stamp `0.6` on v0.5-feature envelopes at the
 * next version bump — the oh-hai#712 drift class recreated inside its own fix. That is why both
 * arms are this module's own named literals and why the tests pin them as string literals.
 */
export function wireVersionFor(envelope: VersionFeatureProbe): A2hVersion {
  let stamped: A2hVersion = WIRE_BASE_VERSION;
  for (const { minimum, present } of Object.values(WIRE_FEATURES)) {
    if (present(envelope) && minorOf(minimum) > minorOf(stamped)) stamped = minimum;
  }
  return stamped;
}

// ---- Envelope builders (spec §4) ----

/**
 * An injectable clock for `created_at` (spec §4). Defaults to the system clock; inject a fixed
 * clock in tests for deterministic envelopes.
 */
export type WireClock = () => Date;

const systemClock: WireClock = () => new Date();

/**
 * The kind-independent builder input — the full optional envelope surface of message.schema.json
 * (spec §4). `ma2h_version` and `created_at` are NOT inputs: the version comes from
 * `wireVersionFor` and the timestamp from the builder's clock. `id` is Hub-assigned and never a
 * client input.
 */
export interface WireEnvelopeInput {
  /** The submitting agent (spec §4.1). `session` present makes the envelope addressed (v0.5). */
  agent: AgentDescriptor;
  title: string;
  /** Optional v0.5 destination (spec §4): `agent:<id>` or `agent:<id>#<session>`. */
  to?: AgentAddress;
  body?: string;
  priority?: Priority;
  /** Omitted from the wire when empty. */
  tags?: string[];
  context?: Part[];
  /** Opaque, agent-owned, agent-integrity-sealed resume blob (spec §9.3). */
  state?: JsonObject;
  /** Opaque correlation label; never a dedup key (spec §4, KTD1). */
  client_ref?: string;
  expires_at?: string;
  sensitive?: boolean;
}

/**
 * `buildNotify` input (spec §4). Deliberately NO `idempotency_key`: the builders treat notify as
 * fire-and-forget and never attach one (the schema's MAY), so key minting stays an explicit
 * ask/task concern — see `newIdempotencyKey`.
 */
export type NotifyInput = WireEnvelopeInput;

/** `buildAsk` input: the shared surface plus the ask-only fields (spec §4, §5.2). */
export interface AskInput extends WireEnvelopeInput {
  /**
   * REQUIRED at the type level (spec §4, KTD1b) — mint once with `newIdempotencyKey()` and reuse
   * the SAME key across retries of this ask.
   */
  idempotency_key: string;
  /** The complete decision request (spec §5.2), incl. options/schema/permissions/`default_on_expire`/`allowed_resolvers`/callback. */
  request: AskRequest;
}

/** `buildTask` input: the shared surface plus the task-only fields (spec §4, §5.3). */
export interface TaskInput extends WireEnvelopeInput {
  /**
   * REQUIRED at the type level (spec §4, KTD1b) — mint once with `newIdempotencyKey()` and reuse
   * the SAME key across retries of this task.
   */
  idempotency_key: string;
  /** The complete manual action (spec §5.3), incl. checklist/verification/`allowed_resolvers`/callback. */
  action: TaskAction;
}

/** The shared envelope fields every kind carries — exactly BaseEnvelope's slice of the message types. */
type BaseFields = Pick<
  NotifyMessage,
  | "ma2h_version"
  | "created_at"
  | "agent"
  | "to"
  | "title"
  | "body"
  | "priority"
  | "tags"
  | "context"
  | "state"
  | "client_ref"
  | "expires_at"
  | "sensitive"
>;

/**
 * Assemble the shared fields: stamp the version, default `created_at` from the clock, and carry
 * each optional through a conditional spread so absent stays ABSENT on the wire (never
 * `undefined`-valued; `exactOptionalPropertyTypes` discipline). The agent descriptor is rebuilt
 * field-by-field so a structurally-widened caller object cannot leak extra keys into the envelope,
 * and every container-valued optional (`tags`/`context`/`state`/`labels`) is DEFENSIVELY COPIED so
 * post-build caller mutation cannot change an envelope under an already-minted idempotency_key.
 */
function baseFields(input: WireEnvelopeInput, clock: WireClock): BaseFields {
  const agent: AgentDescriptor = {
    id: input.agent.id,
    run_id: input.agent.run_id,
    runtime: input.agent.runtime,
    ...(input.agent.session !== undefined ? { session: input.agent.session } : {}),
    ...(input.agent.project !== undefined ? { project: input.agent.project } : {}),
    ...(input.agent.labels !== undefined ? { labels: structuredClone(input.agent.labels) } : {}),
  };
  return {
    ma2h_version: wireVersionFor(input),
    created_at: clock().toISOString(),
    agent,
    ...(input.to !== undefined ? { to: input.to } : {}),
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
    ...(input.context !== undefined ? { context: structuredClone(input.context) } : {}),
    ...(input.state !== undefined ? { state: structuredClone(input.state) } : {}),
    ...(input.client_ref !== undefined ? { client_ref: input.client_ref } : {}),
    ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
  };
}

/**
 * Rebuild an ask's `request` from its known key set (spec §5.2) — as the agent descriptor is —
 * so a structurally-widened caller object cannot leak extra keys onto the wire, with every
 * container-valued member defensively copied so post-build caller mutation cannot change an
 * envelope under an already-minted idempotency_key.
 */
function rebuildRequest(request: AskRequest): AskRequest {
  return {
    mode: request.mode,
    ...(request.options !== undefined ? { options: structuredClone(request.options) } : {}),
    ...(request.schema !== undefined ? { schema: structuredClone(request.schema) } : {}),
    ...(request.permissions !== undefined ? { permissions: structuredClone(request.permissions) } : {}),
    ...(request.default_on_expire !== undefined
      ? { default_on_expire: structuredClone(request.default_on_expire) }
      : {}),
    ...(request.allowed_resolvers !== undefined ? { allowed_resolvers: [...request.allowed_resolvers] } : {}),
    ...(request.callback !== undefined ? { callback: structuredClone(request.callback) } : {}),
  };
}

/** Rebuild a task's `action` from its known key set (spec §5.3) — see `rebuildRequest`. */
function rebuildAction(action: TaskAction): TaskAction {
  return {
    instructions: action.instructions,
    ...(action.checklist !== undefined ? { checklist: structuredClone(action.checklist) } : {}),
    ...(action.verification !== undefined ? { verification: action.verification } : {}),
    ...(action.allowed_resolvers !== undefined ? { allowed_resolvers: [...action.allowed_resolvers] } : {}),
    ...(action.callback !== undefined ? { callback: structuredClone(action.callback) } : {}),
  };
}

/**
 * The builder self-validation net: validate a freshly-built envelope against the registry its
 * STAMPED version selects (the v0.4 registry for a pre-0.5 stamp — no v0.3 registry is published —
 * and the v0.5 registry from minor 5 up), throwing a descriptive `Error` on failure so a
 * misconstruction surfaces at BUILD time, not at submit time. Not a `HubError`: this is the
 * builder's own construction check, not a Hub verdict.
 */
function assertBuiltEnvelope(message: A2hMessage): void {
  const v05 = minorOf(message.ma2h_version) >= 5;
  const result = v05 ? validateV05("message.schema.json", message) : validateMessage(message);
  if (!result.valid) {
    throw new Error(
      `built ${message.type} envelope failed ${v05 ? "v0.5" : "v0.4"} schema validation (builder self-check, stamped ${message.ma2h_version}): ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Build a schema-valid notify envelope (spec §4, §5.1) with the version stamped by
 * `wireVersionFor` and `created_at` from the clock. Never carries an `idempotency_key` — see
 * `NotifyInput`.
 */
export function buildNotify(input: NotifyInput, clock: WireClock = systemClock): NotifyMessage {
  const message: NotifyMessage = { ...baseFields(input, clock), type: "notify" };
  assertBuiltEnvelope(message);
  return message;
}

/**
 * Build a schema-valid ask envelope (spec §4, §5.2). `idempotency_key` is a REQUIRED input
 * (KTD1b, mint-once-reuse — `newIdempotencyKey`) and round-trips verbatim onto the wire.
 */
export function buildAsk(input: AskInput, clock: WireClock = systemClock): AskMessage {
  const message: AskMessage = {
    ...baseFields(input, clock),
    type: "ask",
    idempotency_key: input.idempotency_key,
    request: rebuildRequest(input.request),
  };
  assertBuiltEnvelope(message);
  return message;
}

/**
 * Build a schema-valid task envelope (spec §4, §5.3). `idempotency_key` is a REQUIRED input
 * (KTD1b, mint-once-reuse — `newIdempotencyKey`) and round-trips verbatim onto the wire.
 */
export function buildTask(input: TaskInput, clock: WireClock = systemClock): TaskMessage {
  const message: TaskMessage = {
    ...baseFields(input, clock),
    type: "task",
    idempotency_key: input.idempotency_key,
    action: rebuildAction(input.action),
  };
  assertBuiltEnvelope(message);
  return message;
}

/** Is this parsed JSON value a plain object (the only shape a wire body/row/field may take)? */
const isJsonObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- §8.1 submit-ack validation and the addressed-misroute detector (issue #45, R6) ----

/**
 * The outcome of validating a §8.1 submit ack (the 202 body of `POST /v1/messages`).
 *
 * - `valid: true` — the body is a schema-valid §8.1 ack (and, for an addressed submit, carries a
 *   valid `destination` snapshot); `ack` is the typed, field-checked result.
 * - `misroute: false` — the body is not a usable ack (missing/ill-typed required fields, or
 *   schema-invalid outside the addressed-destination concern). Says nothing about routing.
 * - `misroute: true` — THE ADDRESSED-PATH FAILURE (spec §8.1): the Hub ACCEPTED the submit (the
 *   202 carried an id — `acceptedId`), but the ack's `destination` snapshot is absent or invalid.
 *   On an addressed submit an absent snapshot means a pre-0.5 Hub misrouted the message to the
 *   human inbox, which the sender MUST treat as a failure; `acceptedId` is carried so the sender
 *   can cancel or track the accepted message instead of losing it.
 */
export type SubmitAckValidation =
  | { valid: true; ack: SubmitAck }
  | { valid: false; misroute: false; errors: string[] }
  | { valid: false; misroute: true; acceptedId: string; errors: string[] };

/**
 * The client-side context of the submit this ack answers — the one thing no schema can see
 * (spec §8.1: "the sender-side detector never depends on the schema — the sender knows it
 * addressed the message").
 */
export interface SubmitContext {
  /**
   * True iff the submitted envelope carried `to` (spec §4) — i.e. the v0.5 addressed path.
   * §8.1 sense — keyed strictly on `to`; do NOT derive from the version-rule predicates
   * (`usesInterAgentAddressing`/`usesSessionQualifiedResolvers`), which are broader.
   */
  addressed: boolean;
  /**
   * The submitted envelope's verb — the second thing no schema can see. The submit-ack schema's
   * `status` enum is the UNION of every track's vocabulary, so only the sender can pin the ack's
   * status to the owning track (`statusesFor(type, addressed)`): a `delivered` on a non-addressed
   * ask, or an `open` on a human-inbox notify, is a track contradiction the schema admits.
   * §8.1 replays return the owning track's CURRENT status, so the full per-type table — not just
   * the fresh-accept statuses — is the correct vocabulary.
   */
  type: MessageType;
}

/**
 * Validate a parsed §8.1 submit-ack body — pure, transport-free (issue #45, R6).
 *
 * The four field checks performed directly (`id`/`status`/`poll_url` non-empty strings;
 * `review_url` a string when present) are type NARROWING for extraction, not duplicate rule
 * enforcement — they let the misroute failure carry a typed `acceptedId` even when the schema
 * rejects the body elsewhere (e.g. a bad snapshot). Every schema-encoded BUSINESS rule — the
 * `status` vocabulary, the closed property set, the snapshot's 3-state enum and its `last_seen`
 * pairing, the `msg_` id rule for destination-carrying acks — is DELEGATED to the published
 * `submit-ack.schema.json` via `validateV05`, never re-derived here (so e.g. a 4-state `idle`
 * snapshot dies in the schema, not in hand-rolled client logic). The only NEW logic is the
 * context reading, in both directions: on an addressed submit, an absent `destination` — or one
 * the schema rejects — is the structured misroute failure carrying the accepted id (see
 * `SubmitAckValidation`); on a NON-addressed submit, a `destination` snapshot or an
 * addressed-only status (`queued`/`bounced`/`acknowledged`) is the reverse contradiction and
 * fails structurally too.
 */
export function validateSubmitAck(body: unknown, context: SubmitContext): SubmitAckValidation {
  if (!isJsonObjectLike(body)) {
    return { valid: false, misroute: false, errors: ["ack body must be a JSON object"] };
  }
  const id = body["id"];
  const status = body["status"];
  const pollUrl = body["poll_url"];
  const reviewUrl = body["review_url"];
  const destination = body["destination"];

  const fieldErrors: string[] = [];
  if (typeof id !== "string" || id.length === 0) fieldErrors.push("id must be a non-empty string");
  if (typeof status !== "string" || status.length === 0) fieldErrors.push("status must be a non-empty string");
  if (typeof pollUrl !== "string" || pollUrl.length === 0) fieldErrors.push("poll_url must be a non-empty string");
  if (reviewUrl !== undefined && typeof reviewUrl !== "string") fieldErrors.push("review_url must be a string when present");

  // Schema delegation (R6): everything the schema encodes is the schema's verdict, verbatim.
  const schema = validateV05("submit-ack.schema.json", body);
  const schemaErrors = schema.valid ? [] : schema.errors;

  if (fieldErrors.length > 0) {
    return { valid: false, misroute: false, errors: [...fieldErrors, ...schemaErrors] };
  }
  // The base ack is sound, so the Hub really did accept a message under this id.
  const acceptedId = id as string;

  if (context.addressed) {
    if (destination === undefined) {
      return {
        valid: false,
        misroute: true,
        acceptedId,
        errors: [
          "addressed submit was accepted without a destination snapshot — a pre-0.5 Hub misrouted the message to the human inbox (§8.1)",
        ],
      };
    }
    // Present but invalid: surface exactly the schema's own snapshot verdicts (the delegated
    // enum/pairing rules), mapped into the structured misroute result.
    const destinationErrors = schemaErrors.filter((e) => e.startsWith("/destination"));
    if (destinationErrors.length > 0) {
      return { valid: false, misroute: true, acceptedId, errors: destinationErrors };
    }
  } else {
    // The REVERSE misroute (§8.1): a NON-addressed submit acked with the addressed-path surface —
    // a `destination` snapshot, or an addressed-only mailbox status — means the Hub routed a
    // human-inbox submit onto the inter-agent leg (or the caller misdeclared its context). Either
    // way the ack contradicts what the sender knows it submitted: a structured failure, never a
    // silent pass. (`misroute: true` stays reserved for the addressed-path failure — see
    // `SubmitAckValidation`.)
    const reverseErrors: string[] = [];
    if (destination !== undefined) {
      reverseErrors.push(
        "non-addressed submit was acked with a destination snapshot — the ack contradicts the submit context (§8.1)",
      );
    }
    if (status === "queued" || status === "bounced" || status === "acknowledged") {
      reverseErrors.push(
        `non-addressed submit was acked with addressed-only status ${String(status)} — the ack contradicts the submit context (§8.1/§14.2)`,
      );
    }
    if (reverseErrors.length > 0) {
      return { valid: false, misroute: false, errors: [...reverseErrors, ...schemaErrors] };
    }
  }
  // Track consistency (§8.1/§14.2): the submit-ack schema's `status` enum is the UNION of every
  // track's vocabulary, so only the sender-side context can pin the ack's status to the owning
  // track — `delivered` on a non-addressed ask, or `open` on a human-inbox notify, is schema-valid
  // and track-contradictory. §8.1 replays return the track's CURRENT status, so the full per-type
  // table (not just fresh-accept statuses) is the vocabulary.
  const track = statusesFor(context.type, context.addressed);
  if (!track.includes(status as Status)) {
    return {
      valid: false,
      misroute: false,
      errors: [
        `status ${String(status)} is not in the ${context.addressed ? "addressed" : "human-inbox"} ${context.type} track [${track.join(", ")}] (§8.1/§14.2)`,
        ...schemaErrors,
      ],
    };
  }
  if (schemaErrors.length > 0) {
    return { valid: false, misroute: false, errors: schemaErrors };
  }
  // Sound: each field above passed its direct check, and the closed schema validated the whole
  // body — `status` is a schema-verified enum member and `destination` a schema-verified snapshot.
  // Rebuilt field-by-field (never spread) so no unknown key can leak through the type.
  const ack: SubmitAck = {
    id: acceptedId,
    status: status as SubmitAck["status"],
    poll_url: pollUrl as string,
    ...(reviewUrl !== undefined ? { review_url: reviewUrl as string } : {}),
    ...(destination !== undefined ? { destination: destination as DestinationSnapshot } : {}),
  };
  return { valid: true, ack };
}

// ---- Per-type status tables and poll checks (spec §7, §8.2, §14.2; issue #45, R7) ----
//
// Each table is TRANSCRIBED from the per-type status conditionals of
// schema/v0.5/get-message.schema.json — the authoritative source. A derivation-guard test
// (test/wire.test.ts) loads that schema and asserts each exported table equals the schema's enum
// per type, so a future schema change fails the suite before the tables can drift.

/**
 * An ask's top-level `status` values (spec §7/§8.2): ALWAYS its §7 resolution track, addressed or
 * not — mailbox states never appear here (a bounce surfaces as its `cancelled` auto-resolution).
 */
export const ASK_STATUSES = Object.freeze([
  "open",
  "answered",
  "declined",
  "cancelled",
  "expired",
] as const satisfies ReadonlyArray<Status>);

/**
 * A task's top-level `status` values (spec §7/§8.2): ALWAYS its §7 resolution track, addressed or
 * not — verb-true, no ask terminals (a bounce surfaces as its `dismissed` auto-resolution).
 */
export const TASK_STATUSES = Object.freeze([
  "open",
  "completed",
  "dismissed",
  "expired",
] as const satisfies ReadonlyArray<Status>);

/** A human-inbox (non-addressed) notify is delivered-on-acceptance and has no other state (spec §5.1). */
export const HUMAN_INBOX_NOTIFY_STATUSES = Object.freeze(
  ["delivered"] as const satisfies ReadonlyArray<Status>,
);

/** An ADDRESSED notify's lifecycle IS the §14.2 delivery track (spec §5.1). */
export const ADDRESSED_NOTIFY_STATUSES = Object.freeze([
  "queued",
  "delivered",
  "acknowledged",
  "bounced",
  "expired",
] as const satisfies ReadonlyArray<Status>);

/**
 * The six terminal ask/task statuses — every non-`open` value of the two resolution tracks,
 * DERIVED from the tables above (one definition, the rest derived). A terminal ask/task GET body
 * MUST embed the full Response envelope (spec §8.2; the schema's conditional covers exactly this
 * six-value set, and the derivation-guard test pins the equality).
 */
export const TERMINAL_ASK_TASK_STATUSES: readonly Resolution[] = Object.freeze([
  ...new Set([...ASK_STATUSES, ...TASK_STATUSES].filter((s): s is Resolution => s !== "open")),
]);

/**
 * The status table a poll of this message must draw from (spec §7/§8.2/§14.2). Ask/task use their
 * §7 resolution track on BOTH legs; only notify splits on the addressed context — encoding that
 * pairing once so a consumer cannot check an addressed notify against the human-inbox table (or
 * vice versa), which is exactly the drift a hand-rolled lookup invites.
 */
export function statusesFor(type: MessageType, addressed: boolean): readonly Status[] {
  if (type === "ask") return ASK_STATUSES;
  if (type === "task") return TASK_STATUSES;
  return addressed ? ADDRESSED_NOTIFY_STATUSES : HUMAN_INBOX_NOTIFY_STATUSES;
}

/** What the poller knows about the message it polled — the client-side context of the GET. */
export interface PollExpectation {
  /** The id the poll asked for (the submit ack's `id`); the body must echo it. */
  id: string;
  /** The submitted verb — selects the status table. */
  type: MessageType;
  /**
   * True iff the submitted envelope carried `to` (spec §4) — selects the notify table.
   * §8.1 sense — keyed strictly on `to`; do NOT derive from the version-rule predicates
   * (`usesInterAgentAddressing`/`usesSessionQualifiedResolvers`), which are broader.
   */
  addressed: boolean;
}

/**
 * Check a parsed `GET /v1/messages/{id}` body against what the poller knows (issue #45, R7) —
 * the poll checks every consumer duplicates: the id ECHO-MATCH (a body for some other message
 * must never be read as this one's), the status drawn from the polled type's own table (a
 * mailbox state on an ask, or a resolution on an addressed notify, is a broken or misread body),
 * and terminal-status-requires-Response for all six terminal ask/task statuses (spec §8.2 — a
 * pull-only caller must never lose its resolution or resume data). Pure and transport-free; full
 * envelope validation stays with `get-message.schema.json`.
 */
export function validatePollStatus(body: unknown, expected: PollExpectation): ValidationResult {
  if (!isJsonObjectLike(body)) return { valid: false, errors: ["poll body must be a JSON object"] };
  const errors: string[] = [];
  const id = body["id"];
  if (id !== expected.id) {
    errors.push(`id mismatch: polled ${expected.id} but the body carries ${typeof id === "string" ? id : JSON.stringify(id)}`);
  }
  const status = body["status"];
  const table = statusesFor(expected.type, expected.addressed);
  if (typeof status !== "string" || !(table as readonly string[]).includes(status)) {
    errors.push(
      `status ${typeof status === "string" ? status : JSON.stringify(status)} is not a valid ${
        expected.type === "notify" ? (expected.addressed ? "addressed notify" : "human-inbox notify") : expected.type
      } status (§7/§14.2)`,
    );
  } else if (
    expected.type !== "notify" &&
    (TERMINAL_ASK_TASK_STATUSES as readonly string[]).includes(status) &&
    // JSON `null` is as missing as absent: a pull-only caller can extract no resolution from it.
    (body["response"] === undefined || body["response"] === null)
  ) {
    errors.push(`terminal ${expected.type} status ${status} requires the embedded response (§8.2)`);
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// ---- Drain-batch shape guard and the §8.7.1 entry-kind taxonomy (issue #45, R8) ----

/**
 * The §8.7.1 entry-kind taxonomy — the four keys under which a drained mailbox entry's payload
 * arrives, exported as data so consumers dispatch over THE list instead of re-declaring it. The
 * per-kind ack keys are `ackKeyOf` (client.ts).
 */
export const ENTRY_KINDS = Object.freeze(["directive", "message", "response", "receipt"] as const);

/** One §8.7.1 entry kind — a member of `ENTRY_KINDS`. */
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** The outcome of the drain-batch shape guard: the typed batch, or a WHOLE-BATCH refusal. */
export type DrainBatchValidation =
  | { valid: true; entries: InboxEntryDelivery[] }
  | { valid: false; errors: string[] };

/**
 * Shape-check a parsed drain body (`GET /v1/inbox` — spec §8.7/§8.7.1) as a WHOLE batch
 * (issue #45, R8): the body must be an array, and every row must be an object carrying a
 * non-empty `signature` string plus EXACTLY ONE entry-kind payload object (`ENTRY_KINDS`). One
 * malformed row refuses the ENTIRE batch — consuming the well-formed rows of a malformed body
 * would ack mail out of a response the Hub demonstrably garbled, and an ambiguous row (two entry
 * kinds) would be silently resolved by whichever key a dispatcher happens to test first.
 *
 * Duty order (§13.4): this guards the batch WRAPPER only. Each entry's payload shape, §9.7/§9.8
 * signature, addressee, policy, and dedup remain the per-entry consuming duties (the `Agent`
 * handlers); passing this guard verifies nothing about any entry's authenticity.
 */
export function validateDrainBatch(body: unknown): DrainBatchValidation {
  if (!Array.isArray(body)) {
    return { valid: false, errors: ["drain body must be a JSON array of entry deliveries"] };
  }
  const errors: string[] = [];
  body.forEach((row: unknown, index: number) => {
    if (!isJsonObjectLike(row)) {
      errors.push(`entry ${index}: must be a JSON object`);
      return;
    }
    const signature = row["signature"];
    if (typeof signature !== "string" || signature.length === 0) {
      errors.push(`entry ${index}: signature must be a non-empty string`);
    }
    const kinds = ENTRY_KINDS.filter((kind) => row[kind] !== undefined);
    const kind = kinds[0];
    if (kind === undefined) {
      errors.push(`entry ${index}: carries none of the entry kinds (${ENTRY_KINDS.join("/")})`);
    } else if (kinds.length > 1) {
      errors.push(`entry ${index}: ambiguous — carries ${kinds.join(" and ")}`);
    } else if (!isJsonObjectLike(row[kind])) {
      errors.push(`entry ${index}: ${kind} payload must be a JSON object`);
    }
  });
  if (errors.length > 0) return { valid: false, errors };
  // Sound for the WRAPPER type only: each row verified as { <one entry kind>: object, signature }.
  // The payloads inside remain untrusted and unvalidated — see the duty-order note above.
  return { valid: true, entries: body as InboxEntryDelivery[] };
}

// ---- The strip-unknown-fields duty's field rules (spec §10, §13.4; issue #45, R10) ----
//
// Two consumer contracts share one field vocabulary: the keyed `Agent` STRIPS to these lists
// (client.ts's sanitizers derive from them), and a byte-verbatim consumer — the forwarding
// contract that must never rewrite a delivered entry — REFUSES on them via `validateKnownFields`.
// The lists live on this keyless side so the refusing consumer vendors no keyed machinery;
// client.ts re-exports them beside the sanitizers.
//
// These are the KEEP-lists, NOT the signed content-field lists (signing.ts): a keep-list also
// carries the delivered-but-UNSIGNED advisory fields (`created_at`, `agent`, `expires_at`,
// `idempotency_key`) and is deliberately not derivable from any signed-field list.
//
// Every exported table in this module is Object.frozen: `as const` is compile-only, and an
// additively-MUTATED keep-list would launder unsigned fields through the sanitizers (fails open).

/**
 * Every field a delivered §13.1 directive may carry (inbound-message.schema.json's directive
 * shape) — the sanitize keep-list `sanitizeDirective` projects to and `validateKnownFields`
 * refuses over. List order mirrors the sanitizer's historical output order (presentation-stable);
 * the SET is the contract.
 */
export const DIRECTIVE_KEEP_FIELDS = Object.freeze([
  "ma2h_version",
  "type",
  "id",
  "from",
  "to",
  "created_at",
  "title",
  "body",
  "priority",
  "tags",
  "context",
  "expires_at",
  "sensitive",
] as const satisfies ReadonlyArray<keyof InboundDirective & string>);

/**
 * Every field a delivered §8.7.1 `message` entry may carry, per kind (inbound-message.schema.json's
 * message-entry shape) — the sanitize keep-lists `sanitizeMessageEntry` projects to and
 * `validateKnownFields` refuses over. Note what the delivered form deliberately EXCLUDES: the Hub
 * strips submitter-side machinery (`state`, `client_ref`, callbacks) before delivery, so those are
 * unknown fields HERE even though the §4 submit envelope carries them. List order mirrors the
 * sanitizer's historical output order (presentation-stable); the SET is the contract.
 */
export const MESSAGE_ENTRY_KEEP_FIELDS = Object.freeze({
  notify: Object.freeze([
    "ma2h_version",
    "id",
    "from",
    "to",
    "created_at",
    "agent",
    "title",
    "body",
    "priority",
    "tags",
    "context",
    "expires_at",
    "sensitive",
    "type",
    "idempotency_key",
  ] as const),
  ask: Object.freeze([
    "ma2h_version",
    "id",
    "from",
    "to",
    "created_at",
    "agent",
    "title",
    "body",
    "priority",
    "tags",
    "context",
    "expires_at",
    "sensitive",
    "type",
    "idempotency_key",
    "request",
  ] as const),
  task: Object.freeze([
    "ma2h_version",
    "id",
    "from",
    "to",
    "created_at",
    "agent",
    "title",
    "body",
    "priority",
    "tags",
    "context",
    "expires_at",
    "sensitive",
    "type",
    "idempotency_key",
    "action",
  ] as const),
}) satisfies {
  notify: ReadonlyArray<keyof Extract<InterAgentMessage, { type: "notify" }> & string>;
  ask: ReadonlyArray<keyof Extract<InterAgentMessage, { type: "ask" }> & string>;
  task: ReadonlyArray<keyof Extract<InterAgentMessage, { type: "task" }> & string>;
};

/** A kind `validateKnownFields` has a keep-list for: the directive, or a `message` entry's verb. */
export type FieldRuleKind = "directive" | MessageType;

/** The keep-list of one `FieldRuleKind` — the data `validateKnownFields` reads. */
function keepFieldsFor(kind: FieldRuleKind): readonly string[] {
  return kind === "directive" ? DIRECTIVE_KEEP_FIELDS : MESSAGE_ENTRY_KEEP_FIELDS[kind];
}

/**
 * The REFUSE half of the strip-unknown-fields duty (spec §10/§13.4; issue #45, R10): pass iff the
 * entry carries no field outside its kind's keep-list. For a byte-verbatim consumer (the
 * forwarding contract) stripping is not an option — an unknown, unsigned field must make the
 * entry REFUSED, not silently forwarded as trusted-looking input — and this is that comparison,
 * exported so it cannot be re-derived-and-drifted.
 *
 * Duty order (§13.4): pure field-set comparison — it validates no required field, no value, and
 * no signature (schema validation and §9.7/§9.8 verification are their own duties, and refusing
 * is not a substitute for them).
 */
export function validateKnownFields(entry: unknown, kind: FieldRuleKind): ValidationResult {
  if (!isJsonObjectLike(entry)) return { valid: false, errors: ["entry must be a JSON object"] };
  // Cross-check: an entry that DECLARES its message kind must not be checked against another
  // kind's keep-list (an ask validated as "notify" would refuse on `request` as if it were an
  // unknown field — misleading — or, worse, a subset kind could pass under the wrong contract).
  const declaredType = entry["type"];
  if (kind !== "directive" && typeof declaredType === "string" && declaredType !== kind) {
    return {
      valid: false,
      errors: [`entry declares type "${declaredType}" but was checked as ${kind} (§10/§13.4)`],
    };
  }
  const keep = keepFieldsFor(kind);
  const unknown = Object.keys(entry).filter((field) => !keep.includes(field));
  if (unknown.length > 0) {
    return {
      valid: false,
      errors: unknown.map((field) => `unknown field "${field}" is outside the ${kind} field set (§10/§13.4)`),
    };
  }
  return { valid: true };
}

// ---- The §8.5 error reading: effectiveCode + the semantic classification (issue #45, R9) ----

/**
 * The code to READ this error as, applying §8.5's unknown-code fallback (MUST): a code this
 * implementation recognizes reads as itself; an UNRECOGNIZED code reads as the base code its
 * touchpoint would have returned absent the refinement. `undefined` when neither the code nor its
 * class is recognizable — the caller must then stay loud rather than invent a reading.
 *
 * The `isKnownHubErrorCode` gate is load-bearing and is NOT "is this code mapped below". A
 * recognized code the bridge deliberately does not map — `not_found`, `rate_limited` — must keep
 * propagating as itself; routing it through the base-code table would hand it exit semantics §8.5
 * never gives it. Only genuinely unrecognized codes fall back.
 */
export function effectiveCode(e: unknown, touchpoint: HubTouchpoint): KnownHubErrorCode | undefined {
  // Guard non-object inputs exactly as `classifyHubError` does: a null/undefined/primitive error
  // takes the no-code path (`undefined`), never a TypeError out of the reader itself.
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  // §8.5's envelope REQUIRES `code`. A MISSING one is a malformed response or a broken adapter, not
  // an unrecognized refinement — the fallback does not apply, and the failure must stay loud. Fall
  // back on a code-less 410 and a supervisor re-registers against a broken transport forever;
  // fall back on a code-less 401 and it chases a credential that was never the problem.
  if (typeof code !== "string" || code === "") return undefined;
  if (isKnownHubErrorCode(code)) return code;
  return baseCodeForStatus((e as { status?: number }).status, touchpoint);
}

/**
 * The six semantic classes of a Hub error, read per §8.5 at a §16.3 touchpoint (issue #45, R9) —
 * classified, never pre-mapped: what each class means for the caller is per-implementation policy
 * (the reference's exit-code mapping lives in agent.ts), and the raw `error.code` is always
 * preserved on the error the caller still holds.
 *
 * - `auth` — the CALLER's credential failed (`unauthenticated`/`not_authorized`/
 *   `agent_id_mismatch`, §9.1): fix credentials; reads the same at every touchpoint.
 * - `operator-close` — the §16.4 kill-switch (`session_closed_by_operator`): the account's human
 *   closed this session — STOP; never re-register or restart.
 * - `own-terminal` — the presented own session is terminal (`gone`, §16.3): lease lapsed or
 *   self-closed — the re-register-and-continue class, which is exactly what `operator-close` must
 *   never be collapsed into.
 * - `lost-cas-race` — `already_terminal` (§7): another resolver won the CAS; a normal outcome at
 *   the resolve touchpoint, not a failure of this caller.
 * - `unreadable` — STRICTLY the code-less/malformed case: §8.5's envelope requires `code`, so its
 *   absence is a broken response/adapter, never an additive refinement. Stay loud.
 * - `propagate` — a code §8.5 gives THIS caller no reading to act on, passing through AS ITSELF:
 *   recognized-but-unmapped codes (`not_found`, `rate_limited`, `destination_gone`, …) keep their
 *   own meaning, and unrecognized codes with no base-code reading at this touchpoint (no/odd
 *   status, or a class §8.5 leaves blank there — e.g. a 410 at a session-lifecycle call) stay
 *   loud rather than acquire an invented one. A permanent vendored classification must never
 *   label a READABLE code `unreadable` — that is why these are two distinct classes.
 */
export type HubErrorClass =
  | "auth"
  | "operator-close"
  | "own-terminal"
  | "lost-cas-race"
  | "unreadable"
  | "propagate";

/**
 * One classified Hub error. A mapped class always carries the §8.5 effective code it was read
 * from; `propagate` carries it only when the code is recognized (an unrecognized code with no
 * fallback reading has no effective code — the raw one stays on the error itself); `unreadable`
 * has none by definition.
 */
export type HubErrorReading =
  | { class: "auth" | "operator-close" | "own-terminal" | "lost-cas-race"; code: KnownHubErrorCode }
  | { class: "propagate"; code?: KnownHubErrorCode }
  | { class: "unreadable" };

/**
 * Classify a Hub error into its §8.5 semantic class at the caller's touchpoint (issue #45, R9).
 *
 * Reads through `effectiveCode`, so §8.5's unknown-code fallback (MUST) is applied per touchpoint
 * before classifying — an unrecognized 410 at a presentation touchpoint classifies `own-terminal`
 * (its base code is `gone`), while the same error at a session-lifecycle call classifies
 * `propagate` (§8.5 gives that cell no reading). A RECOGNIZED code never falls back, which is what
 * keeps the §16.4 kill-switch outranking its own 410 class: a literal
 * `session_closed_by_operator` classifies `operator-close`, never `own-terminal`.
 *
 * The consumption contract mirrors `EntryVerdict`'s: switch exhaustively over `reading.class` and
 * close with a `never`-assertion — a HANDLING default branch is the misuse, because folding
 * `operator-close` into a default re-register path drives a killed session straight back through
 * the §16.4 kill-switch (the drift class oh-hai#719 documents: an implementation that discarded
 * `error.code` re-registered through the operator kill).
 */
export function classifyHubError(e: unknown, touchpoint: HubTouchpoint): HubErrorReading {
  const raw = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (typeof raw !== "string" || raw === "") return { class: "unreadable" };
  const code = effectiveCode(e, touchpoint);
  if (code === undefined) return { class: "propagate" }; // unrecognized, and no §8.5 reading here
  switch (code) {
    case "unauthenticated":
    case "not_authorized":
    case "agent_id_mismatch":
      return { class: "auth", code };
    case "session_closed_by_operator":
      return { class: "operator-close", code };
    case "gone":
      return { class: "own-terminal", code };
    case "already_terminal":
      return { class: "lost-cas-race", code };
    default:
      return { class: "propagate", code };
  }
}
