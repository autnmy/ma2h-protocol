// Envelope validation — spec §4–§6. Backs the validators with the published JSON
// Schemas via ajv (draft 2020-12), so the reference validator and the conformance
// vectors agree by construction.

import { readFileSync } from "node:fs";
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
