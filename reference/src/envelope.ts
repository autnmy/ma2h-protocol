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
}

const require = createRequire(import.meta.url);
const ajvMod = require("ajv/dist/2020") as { default?: unknown };
const AjvCtor = (ajvMod.default ?? ajvMod) as { new (opts?: Record<string, unknown>): AjvLike };
const formatsMod = require("ajv-formats") as { default?: unknown };
const addFormats = (formatsMod.default ?? formatsMod) as (ajv: AjvLike) => unknown;

const SCHEMA_DIR = new URL("../../schema/v0.3/", import.meta.url);
const SCHEMA_FILES = [
  "message.schema.json",
  "response.schema.json",
  "submit-ack.schema.json",
  "get-message.schema.json",
  "capability.schema.json",
] as const;
const BASE = "https://ahcpprotocol.org/schema/v0.3/";

const ajv: AjvLike = new AjvCtor({ strict: false, allErrors: true });
addFormats(ajv);
for (const file of SCHEMA_FILES) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), "utf8")));
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
