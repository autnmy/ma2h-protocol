// The KEYLESS half of the vendorable client layer (issue #45) — client-side wire mechanics a
// consumer can use while holding no signing key: the canonical envelope builders for the §4
// submit surface and the client-side version-stamp rule (§10). The other keyless mechanics this
// module's charter covers — §8.1 submit-ack/misroute validation, the §14.2 per-type status
// tables, and the §8.5 error reading — land beside these under the same covenant.
//
// VENDORABLE COVENANT (issue #45; spec §4, §8.1, §10, §14.2): downstream consumers vendor this
// file byte-for-byte and import it per-file (subpath exports), so PLACEMENT IS API — no renames
// and no symbol relocation after landing. This module must introduce no `new HubError` sites:
// `test/errors.test.ts` scans `src/` flat and floors the emitter count, and the keyless side
// only ever READS Hub errors — it never mints them.

import { randomUUID } from "node:crypto";

import type {
  A2hVersion,
  AgentAddress,
  AgentDescriptor,
  AskMessage,
  AskRequest,
  JsonObject,
  NotifyMessage,
  Part,
  Priority,
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
 * The envelope fields the version rule (and the `addressed` feature test) reads — structurally
 * satisfied by any `A2hMessage` or builder input, so consumers can classify envelopes they did
 * not build.
 */
export interface VersionFeatureProbe {
  to?: AgentAddress;
  agent: Pick<AgentDescriptor, "session">;
}

/**
 * Is this envelope ADDRESSED — i.e. on the v0.5 inter-agent leg? True iff `to` is present
 * (spec §4) or `agent.session` is present (spec §4.1). Either feature commits the envelope to
 * minor >= 5 (message.schema.json's root conditional enforces the same rule server-side).
 */
export function isAddressedEnvelope(envelope: VersionFeatureProbe): boolean {
  return envelope.to !== undefined || envelope.agent.session !== undefined;
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
export const WIRE_FEATURES = {
  /** `to` and/or `agent.session` — the v0.5 inter-agent addressing surface (spec §4, §4.1). */
  addressed: { minimum: "0.5", present: isAddressedEnvelope },
} as const satisfies Record<
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
 * `"0.3"` for a plain envelope and `"0.5"` for an addressed one.
 *
 * `MA2H_VERSION` is deliberately NOT an input. Lowest-minor-required is a STATIC property of the
 * features an envelope carries, not of the version this implementation currently speaks: coupling
 * the addressed arm to `MA2H_VERSION` would silently stamp `0.6` on v0.5-feature envelopes at the
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
 * field-by-field so a structurally-widened caller object cannot leak extra keys into the envelope.
 */
function baseFields(input: WireEnvelopeInput, clock: WireClock): BaseFields {
  const agent: AgentDescriptor = {
    id: input.agent.id,
    run_id: input.agent.run_id,
    runtime: input.agent.runtime,
    ...(input.agent.session !== undefined ? { session: input.agent.session } : {}),
    ...(input.agent.project !== undefined ? { project: input.agent.project } : {}),
    ...(input.agent.labels !== undefined ? { labels: input.agent.labels } : {}),
  };
  return {
    ma2h_version: wireVersionFor(input),
    created_at: clock().toISOString(),
    agent,
    ...(input.to !== undefined ? { to: input.to } : {}),
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.client_ref !== undefined ? { client_ref: input.client_ref } : {}),
    ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
  };
}

/**
 * Build a schema-valid notify envelope (spec §4, §5.1) with the version stamped by
 * `wireVersionFor` and `created_at` from the clock. Never carries an `idempotency_key` — see
 * `NotifyInput`.
 */
export function buildNotify(input: NotifyInput, clock: WireClock = systemClock): NotifyMessage {
  return { ...baseFields(input, clock), type: "notify" };
}

/**
 * Build a schema-valid ask envelope (spec §4, §5.2). `idempotency_key` is a REQUIRED input
 * (KTD1b, mint-once-reuse — `newIdempotencyKey`) and round-trips verbatim onto the wire.
 */
export function buildAsk(input: AskInput, clock: WireClock = systemClock): AskMessage {
  return {
    ...baseFields(input, clock),
    type: "ask",
    idempotency_key: input.idempotency_key,
    request: input.request,
  };
}

/**
 * Build a schema-valid task envelope (spec §4, §5.3). `idempotency_key` is a REQUIRED input
 * (KTD1b, mint-once-reuse — `newIdempotencyKey`) and round-trips verbatim onto the wire.
 */
export function buildTask(input: TaskInput, clock: WireClock = systemClock): TaskMessage {
  return {
    ...baseFields(input, clock),
    type: "task",
    idempotency_key: input.idempotency_key,
    action: input.action,
  };
}
