// The Hub error-code vocabulary and its §8.5 status classes (spec §8.5, §16.3; issue #43).
// A standalone, dependency-free module — deliberately shaped like `version.ts` — so downstream
// Hubs can vendor it byte-for-byte and import the one definition instead of re-declaring the code
// set wherever an error is minted or matched.
//
// ONE definition, re-derived nowhere: `HUB_ERROR_STATUS` is the table; `KnownHubErrorCode` is
// `keyof typeof` it; the status lookup and the membership guard both read it. There is no second
// declaration of the code set to drift from the first — the discipline #41 applied to the wire
// version and the shared MAC rule, now applied to error codes.

/** The HTTP status classes §8.5 defines. */
export type HubErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429;

/**
 * Every `error.code` in the protocol's vocabulary, mapped to the §8.5 status class it is returned
 * under. THE one definition — everything else in this module derives from it, and `HubError.status`
 * is a lookup into it rather than a value hand-passed at ~50 throw sites (which would reintroduce
 * exactly the drift issue #43 is about).
 *
 * Three rows earn a note:
 * - `not_acknowledgeable` is emitted by the reference Hub but is absent from §8.5's table. §14.3
 *   supplies the class directly — "acking an `open` message is `409`" — the same "state does not
 *   permit this action" reading as `already_terminal`.
 * - `agent_id_mismatch` and `idempotency_conflict` are §8.5 vocabulary this Hub does not currently
 *   emit (`mapHubError` already matches the former). The table documents the PROTOCOL's vocabulary,
 *   not one Hub's emissions, so a consumer classing a peer Hub's error still finds them here.
 */
export const HUB_ERROR_STATUS = {
  validation_error: 400,
  version_not_supported: 400,
  unauthenticated: 401,
  agent_id_mismatch: 403,
  not_authorized: 403,
  not_found: 404,
  idempotency_conflict: 409,
  already_terminal: 409,
  not_acknowledgeable: 409,
  gone: 410,
  destination_gone: 410,
  session_closed_by_operator: 410,
  invalid_field: 422,
  unknown_destination: 422,
  rate_limited: 429,
} as const satisfies Record<string, HubErrorStatus>;

/** A code in the protocol's own vocabulary — the CLOSED union, derived from the table above. */
export type KnownHubErrorCode = keyof typeof HUB_ERROR_STATUS;

/**
 * An `error.code` on the wire. Open by design: §8.5 says additive codes REFINE a class rather than
 * replace it, so a downstream Hub may emit a code this implementation has never heard of, and both
 * `HubError` and `A2hError` must accept one.
 *
 * What `(string & {})` buys is editor AUTOCOMPLETE over the known vocabulary while still admitting
 * any string. It is **not** typo rejection, and no open union can be: `"gonee"` type-checks here
 * exactly as it would against bare `string`. The drift protection lives in two other places, on
 * purpose — `test/errors.test.ts` scans `src/**` and fails the build on an emitted code outside the
 * table, and a code the table cannot class makes `mapHubError` rethrow loudly (§8.5's fallback is
 * gated on a RECOGNIZED class) instead of mapping to a wrong exit.
 */
export type HubErrorCode = KnownHubErrorCode | (string & {});

/** Does this implementation RECOGNIZE the code (§8.5)? The gate on the unknown-code fallback. */
export function isKnownHubErrorCode(code: string | undefined): code is KnownHubErrorCode {
  return code !== undefined && Object.hasOwn(HUB_ERROR_STATUS, code);
}

/** The §8.5 status class of a code, or `undefined` for a code outside the vocabulary. */
export function statusOfHubErrorCode(code: string | undefined): HubErrorStatus | undefined {
  return isKnownHubErrorCode(code) ? HUB_ERROR_STATUS[code] : undefined;
}

/**
 * The §16.3 touchpoint rows. §8.5's fallback resolves an unrecognized code to "the code that
 * touchpoint would return absent the refinement", so a caller cannot ask the question without
 * saying which touchpoint it is standing at.
 */
export type HubTouchpoint =
  /** Presenting an own session: drain / ack (`?session=`), resolve (`?session=`), stream connect. */
  | "presentation"
  /** A submit naming the submitter's own `agent.session` (§4.1). */
  | "own-session-submit"
  /** An addressed send — `to` naming a destination (§4). */
  | "addressed-send";

/** A class §8.5 gives ONE base code, so the touchpoint does not enter into the reading. */
function atEveryTouchpoint(code: KnownHubErrorCode): Record<HubTouchpoint, KnownHubErrorCode> {
  return { presentation: code, "own-session-submit": code, "addressed-send": code };
}

/**
 * §8.5's unknown-code fallback as a table: within a recognized status class, the BASE code that
 * touchpoint returns absent any refinement.
 *
 * The shape carries the point — a row spells out per-touchpoint readings exactly when §8.5 gives
 * its class more than one base code, which is the case §8.5 says the touchpoint must disambiguate:
 *
 * - **409** — `idempotency_conflict` is the SUBMIT reading (a replay with a differing payload,
 *   §8.1); `already_terminal` is the cancel/resolve-after-terminal reading, which is the one a
 *   presentation touchpoint reaches.
 * - **410** — `gone` when presenting an own session, `destination_gone` when addressing a
 *   destination (§16.3).
 * - **422** — `invalid_field`, except on an addressed send, where the collapsed destination reading
 *   is `unknown_destination` (§4).
 *
 * Annotated `Record<HubErrorStatus, …>` rather than `satisfies` alone: a status class added to
 * `HubErrorStatus` without a row here is then a compile error, not a silent hole in the fallback.
 */
const BASE_CODE_BY_CLASS: Record<HubErrorStatus, Record<HubTouchpoint, KnownHubErrorCode>> = {
  400: atEveryTouchpoint("validation_error"),
  401: atEveryTouchpoint("unauthenticated"),
  403: atEveryTouchpoint("not_authorized"),
  404: atEveryTouchpoint("not_found"),
  409: {
    presentation: "already_terminal",
    "own-session-submit": "idempotency_conflict",
    "addressed-send": "idempotency_conflict",
  },
  410: {
    presentation: "gone",
    "own-session-submit": "destination_gone",
    "addressed-send": "destination_gone",
  },
  422: {
    presentation: "invalid_field",
    "own-session-submit": "invalid_field",
    "addressed-send": "unknown_destination",
  },
  429: atEveryTouchpoint("rate_limited"),
};

/** Is this one of the status classes §8.5 defines? */
export function isHubErrorStatus(status: number | undefined): status is HubErrorStatus {
  return status !== undefined && Object.hasOwn(BASE_CODE_BY_CLASS, status);
}

/**
 * §8.5 (MUST): resolve an UNRECOGNIZED code to the base code its touchpoint would have returned.
 * `undefined` when the status is absent or outside §8.5's classes — the caller must then stay loud
 * rather than invent a reading for a class the spec does not define.
 */
export function baseCodeForStatus(
  status: number | undefined,
  touchpoint: HubTouchpoint,
): KnownHubErrorCode | undefined {
  return isHubErrorStatus(status) ? BASE_CODE_BY_CLASS[status][touchpoint] : undefined;
}
