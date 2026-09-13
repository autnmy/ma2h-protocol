// Envelope validation — spec §4–§6. Backs the validators with the published JSON
// Schemas via ajv (draft 2020-12), so the reference validator and the conformance
// vectors agree by construction.

import { readFileSync } from "node:fs";
import type { ResponseOption } from "./types.js";
import { createRequire } from "node:module";

// Minimal local typing of the ajv surface we use — avoids ajv's awkward
// default-export-as-namespace typing while keeping our boundary fully typed.
interface ValidateFn {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
}
interface AjvLike {
  addSchema(schema: unknown): unknown;
  getSchema(id: string): ValidateFn | undefined;
  compile(schema: unknown): ValidateFn;
}

const require = createRequire(import.meta.url);
const ajvMod = require("ajv/dist/2020") as { default?: unknown };
const AjvCtor = (ajvMod.default ?? ajvMod) as { new (opts?: Record<string, unknown>): AjvLike };
const formatsMod = require("ajv-formats") as { default?: unknown };
const addFormats = (formatsMod.default ?? formatsMod) as (ajv: AjvLike) => unknown;

const SCHEMA_DIR = new URL("../../schema/v0.4/", import.meta.url);
const SCHEMA_FILES = [
  "message.schema.json",
  "response.schema.json",
  "submit-ack.schema.json",
  "get-message.schema.json",
  "capability.schema.json",
  "inbound-message.schema.json",
  "ack.schema.json",
  "presence.schema.json",
] as const;
const BASE = "https://ma2h.org/schema/v0.4/";

const ajv: AjvLike = new AjvCtor({ strict: false, allErrors: true });
addFormats(ajv);
for (const file of SCHEMA_FILES) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), "utf8")));
}

// v0.5 snapshot (spec/v0.5.md): a SECOND registry so v0.5-targeted conformance
// vectors validate against schema/v0.5/ while every v0.4 validator above runs
// byte-identically. The v0.5 reference *implementation* lands with issue #26;
// this registry only powers schema validation.
const SCHEMA_DIR_V05 = new URL("../../schema/v0.5/", import.meta.url);
const SCHEMA_FILES_V05 = [
  "message.schema.json",
  "response.schema.json",
  "submit-ack.schema.json",
  "get-message.schema.json",
  "capability.schema.json",
  "inbound-message.schema.json",
  "ack.schema.json",
  "presence.schema.json",
  "session.schema.json",
  "resolve-request.schema.json",
] as const;
const BASE_V05 = "https://ma2h.org/schema/v0.5/";

const ajvV05: AjvLike = new AjvCtor({ strict: false, allErrors: true });
addFormats(ajvV05);
for (const file of SCHEMA_FILES_V05) {
  ajvV05.addSchema(JSON.parse(readFileSync(new URL(file, SCHEMA_DIR_V05), "utf8")));
}

// v0.6 snapshot (spec/v0.6.md): a THIRD registry, added for the same reason the v0.5 one was —
// v0.6-targeted vectors validate against schema/v0.6/ while every v0.4 and v0.5 validator above
// stays byte-identical. v0.6 is a corrective release confined to the `ask` contract (§5.2/§6):
// `options` gains uniqueItems, `request.schema` must describe an answer object, `permissions`
// drops `allow_accept` and defines `allow_edit`, and `response.edited` gains its semantics. Every
// other schema in the snapshot is the v0.5 file re-`$id`'d.
const SCHEMA_DIR_V06 = new URL("../../schema/v0.6/", import.meta.url);
const SCHEMA_FILES_V06 = SCHEMA_FILES_V05;
const BASE_V06 = "https://ma2h.org/schema/v0.6/";

const ajvV06: AjvLike = new AjvCtor({ strict: false, allErrors: true });
addFormats(ajvV06);
for (const file of SCHEMA_FILES_V06) {
  ajvV06.addSchema(JSON.parse(readFileSync(new URL(file, SCHEMA_DIR_V06), "utf8")));
}

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

function runValidator(schemaId: string, data: unknown): ValidationResult {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not loaded: ${schemaId}`);
  if (validate(data)) return { valid: true };
  const errors = (validate.errors ?? []).map((e) =>
    `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
  );
  return { valid: false, errors };
}

export const validateMessage = (data: unknown): ValidationResult =>
  runValidator(BASE + "message.schema.json", data);

export const validateResponse = (data: unknown): ValidationResult =>
  runValidator(BASE + "response.schema.json", data);

export const validateCapability = (data: unknown): ValidationResult =>
  runValidator(BASE + "capability.schema.json", data);

/** Validate a human→agent directive envelope (spec §13.1, v0.4). */
export const validateInboundMessage = (data: unknown): ValidationResult =>
  runValidator(BASE + "inbound-message.schema.json", data);

/** Validate an acknowledgment/receipt envelope (spec §14.1, v0.4). */
export const validateAck = (data: unknown): ValidationResult =>
  runValidator(BASE + "ack.schema.json", data);

/** Validate a presence read body (spec §15.3, v0.4). */
export const validatePresence = (data: unknown): ValidationResult =>
  runValidator(BASE + "presence.schema.json", data);

function resultFrom(validate: ValidateFn, data: unknown): ValidationResult {
  if (validate(data)) return { valid: true };
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { valid: false, errors };
}

/**
 * Validate against a v0.5 schema by filename (e.g. "message.schema.json").
 * Backs conformance vectors whose `target` carries the "v0.5/" prefix.
 */
export function validateV05(schemaFile: string, data: unknown): ValidationResult {
  if (!(SCHEMA_FILES_V05 as readonly string[]).includes(schemaFile)) {
    throw new Error(`unknown v0.5 schema: ${schemaFile}`);
  }
  const validate = ajvV05.getSchema(BASE_V05 + schemaFile);
  if (!validate) throw new Error(`schema not loaded: ${BASE_V05 + schemaFile}`);
  return resultFrom(validate, data);
}

/**
 * Validate against a `$def` inside a v0.5 schema (e.g. the `registerRequest`/`sessionList` wrapper
 * shapes in session.schema.json, spec §16.1). ajv resolves the JSON-pointer fragment against the
 * registered root schema's `$id`.
 */
export function validateV05Def(schemaFile: string, def: string, data: unknown): ValidationResult {
  const ref = `${BASE_V05}${schemaFile}#/$defs/${def}`;
  const validate = ajvV05.getSchema(ref);
  if (!validate) throw new Error(`schema $def not loaded: ${ref}`);
  return resultFrom(validate, data);
}

/**
 * Validate against a v0.6 schema by filename (e.g. "message.schema.json").
 * Backs conformance vectors whose `target` carries the "v0.6/" prefix.
 */
export function validateV06(schemaFile: string, data: unknown): ValidationResult {
  if (!(SCHEMA_FILES_V06 as readonly string[]).includes(schemaFile)) {
    throw new Error(`unknown v0.6 schema: ${schemaFile}`);
  }
  const validate = ajvV06.getSchema(BASE_V06 + schemaFile);
  if (!validate) throw new Error(`schema not loaded: ${BASE_V06 + schemaFile}`);
  return resultFrom(validate, data);
}

/** Validate against a `$def` inside a v0.6 schema — the v0.6 twin of `validateV05Def`. */
export function validateV06Def(schemaFile: string, def: string, data: unknown): ValidationResult {
  const ref = `${BASE_V06}${schemaFile}#/$defs/${def}`;
  const validate = ajvV06.getSchema(ref);
  if (!validate) throw new Error(`schema $def not loaded: ${ref}`);
  return resultFrom(validate, data);
}

/**
 * The two v0.6 `ask` rules a JSON Schema cannot express, so a Hub must enforce them itself
 * (spec §5.2, §12 class-3). Exported so an implementation discharges the obligation with the
 * reference's reading of it rather than a re-derived one.
 */

/**
 * `options[].value` MUST be unique within `options` (spec §5.2, v0.6). JSON Schema has no
 * uniqueness-by-sub-property keyword — `uniqueItems` compares whole items, so it cannot see that
 * two options with the same `value` and different `label`s collide. Returns the first duplicated
 * value, or null when the array is unique (or absent/not an array, which is the schema's business).
 *
 * Why it matters: §6 returns the chosen `value` and nothing identifying WHICH entry produced it, so
 * a duplicate makes the Response ambiguous at the protocol level — unrecoverable at either end,
 * because the distinguishing information was never on the wire.
 */
/**
 * Does a JSON Schema `type` keyword ADMIT an object? The question the v0.6 answerability rule
 * actually asks (spec §5.2) — not "is it the literal string `object`".
 *
 * JSON Schema allows `type` to be a string OR an array of strings, so `{"type": ["object", "null"]}`
 * is a legitimate, answerable schema. An earlier draft of this rule tested for the literal
 * `"object"` and rejected it: that broke a sender whose schema was fine, which is exactly the class
 * of over-reach a CORRECTIVE release must not commit (codex, PR #65). Anything that is neither a
 * string nor an array of strings is not a valid `type` keyword at all, so it cannot admit anything.
 */
function admitsObject(type: unknown): boolean {
  if (typeof type === "string") return type === "object";
  if (Array.isArray(type)) return type.includes("object");
  return false;
}

/**
 * The EFFECTIVE options of an ask — what a resolver may choose from, which is not always
 * `request.options` (spec §5.2).
 *
 * `mode=confirm` is sugar: when `options` is omitted the Hub MUST synthesize exactly two, `approve`
 * and `deny`. Membership must therefore be tested against the synthesized pair, or an answer that
 * is genuinely off-menu on such an ask reads as on-menu and `edited` comes back `false` — the flag
 * silently lying in precisely the direction it exists to prevent (codex, PR #65).
 *
 * Returns null when there is no option set to speak of (`mode=input`), which is distinct from an
 * empty one.
 */
export function effectiveOptions(
  request: { mode?: unknown; options?: unknown } | null | undefined,
): ResponseOption[] | null {
  if (!request) return null;
  if (Array.isArray(request.options)) return request.options as ResponseOption[];
  if (request.mode === "confirm") {
    return [
      { value: "approve", label: "Approve" },
      { value: "deny", label: "Deny" },
    ];
  }
  return null;
}

export function duplicateOptionValue(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  const seen = new Set<string>();
  for (const o of options) {
    if (typeof o !== "object" || o === null) continue;
    const v = (o as { value?: unknown }).value;
    if (typeof v !== "string") continue;
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

/**
 * A `mode=input` `request.schema` MUST describe the ANSWER OBJECT (spec §5.2/§6, v0.6): `type`
 * "object" if present, and at least one `properties` entry. Returns a reason string when the schema
 * is unanswerable, or null when it is fine.
 *
 * Both failures are determinable at SUBMIT time, which is the whole point of checking here: a
 * scalar schema admits no object and so no §6-valid answer, and a property-less one presents the
 * human with nothing to fill in. Deferring either to resolve time reports it only to the human, who
 * cannot fix the agent's schema and has no channel to say what is wrong.
 */
export function unanswerableInputSchema(schema: unknown): string | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "request.schema must be a JSON object";
  }
  const s = schema as { type?: unknown; properties?: unknown };
  if (s.type !== undefined && !admitsObject(s.type)) {
    return `request.schema must describe an object (got type ${JSON.stringify(s.type)}): the answer to an input ask is an object (spec §6)`;
  }
  const props = s.properties;
  if (typeof props !== "object" || props === null || Array.isArray(props) || Object.keys(props).length === 0) {
    return "request.schema must define at least one entry under `properties` — a schema with no properties renders no fields and cannot be answered";
  }
  return null;
}

/**
 * `response.edited` (spec §6, v0.6): true IFF `value` is not a member of the ask's EFFECTIVE
 * `options[].value`. Computed from the answer itself — never from which affordance the human used —
 * so it is a property of the answer that the agent can independently recompute, and two resolutions
 * carrying the same value against the same options always agree.
 *
 * Takes the whole `request`, not a bare options array, because the effective set is not always
 * `request.options`: a `confirm` with `options` omitted has the Hub-synthesized `approve`/`deny`
 * pair (§5.2). Passing the raw array there would mark an answer of `"later"` as NOT edited, since
 * there is no array to be outside of — the flag lying in exactly the direction it exists to prevent.
 *
 * False for a non-string value (`mode=input` answers are objects, and there are no options for them
 * to be outside of), and false when the ask has no effective option set at all.
 */
export function isEditedAnswer(
  request: { mode?: unknown; options?: unknown } | null | undefined,
  value: unknown,
): boolean {
  if (typeof value !== "string") return false;
  const options = effectiveOptions(request);
  if (options === null) return false;
  return !options.some(
    (o) => typeof o === "object" && o !== null && (o as { value?: unknown }).value === value,
  );
}

/**
 * Validate a value against an agent-supplied FLAT JSON Schema — the `request.schema` of an
 * input-mode ask (spec §5.2/§8.8). Compiled on the v0.5 ajv (draft 2020-12 + formats). A schema
 * that ajv cannot compile is reported as an invalid answer rather than throwing.
 */
export function validateAgainstSchema(schema: unknown, data: unknown): ValidationResult {
  let validate: ValidateFn;
  try {
    validate = ajvV05.compile(schema);
  } catch (e) {
    return { valid: false, errors: [`uncompilable request.schema: ${(e as Error).message}`] };
  }
  return resultFrom(validate, data);
}
