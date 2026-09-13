// The v0.6 `ask` contract (spec §5.2, §6) — the two rules JSON Schema cannot express, plus the
// membership rule that defines `response.edited`. These back the class-3 obligations dp-026/027/028;
// the schema-expressible half is covered by sv-067..074 through the vector runner.

import test from "node:test";
import assert from "node:assert/strict";
import {
  duplicateOptionValue,
  unanswerableInputSchema,
  isEditedAnswer,
  effectiveOptions,
  validateV06,
} from "../src/envelope.js";

// ---- options[].value uniqueness (§5.2) ----

test("duplicateOptionValue catches a collision the SCHEMA cannot see", () => {
  // The whole reason this helper exists: `uniqueItems` compares whole items, so two options that
  // share a `value` but differ in `label` are distinct array items and validate cleanly. The schema
  // says "valid" (pinned by sv-071) while the answer they produce is ambiguous.
  const options = [
    { value: "approve", label: "Approve and deploy" },
    { value: "approve", label: "Approve but hold" },
  ];
  const envelope = {
    ma2h_version: "0.6",
    type: "ask",
    created_at: "2026-09-13T10:00:00Z",
    agent: { id: "a", run_id: "r", runtime: "cli" },
    title: "t",
    idempotency_key: "k",
    request: { mode: "select", options },
  };
  assert.equal(validateV06("message.schema.json", envelope).valid, true);
  assert.equal(duplicateOptionValue(options), "approve");
});

test("duplicateOptionValue passes distinct values and ignores label/description duplication", () => {
  // Two choices MAY read alike to a human and mean different things to the agent. `value` alone
  // discriminates, so only `value` is constrained.
  assert.equal(
    duplicateOptionValue([
      { value: "ship", label: "Go", description: "same words" },
      { value: "hold", label: "Go", description: "same words" },
    ]),
    null,
  );
});

test("duplicateOptionValue reports the FIRST duplicate and tolerates junk entries", () => {
  assert.equal(
    duplicateOptionValue([{ value: "a" }, { value: "b" }, { value: "a" }, { value: "b" }]),
    "a",
  );
  // Shape errors are the schema's business; this helper must not throw on them.
  assert.equal(duplicateOptionValue([null, 7, "x", { value: 1 }]), null);
  assert.equal(duplicateOptionValue(undefined), null);
  assert.equal(duplicateOptionValue("not an array"), null);
});

// ---- request.schema answerability (§5.2, §6) ----

test("unanswerableInputSchema rejects a scalar schema — no object can satisfy it", () => {
  // §6 fixes the input answer as an object. A string schema admits no object, so the ask is
  // unanswerable the instant it is accepted. This is the shape observed in production under v0.5.
  const why = unanswerableInputSchema({ type: "string", minLength: 1 });
  assert.ok(why && why.includes("must describe an object"));
});

test("unanswerableInputSchema rejects a schema with no properties — nothing to fill in", () => {
  assert.ok(unanswerableInputSchema({ type: "object" })?.includes("`properties`"));
  assert.ok(unanswerableInputSchema({ type: "object", properties: {} })?.includes("`properties`"));
  assert.ok(unanswerableInputSchema({})?.includes("`properties`"));
});

test("unanswerableInputSchema accepts an answer-object schema, with or without an explicit type", () => {
  assert.equal(unanswerableInputSchema({ type: "object", properties: { reason: { type: "string" } } }), null);
  // `properties` is the load-bearing requirement; `type` MAY be omitted.
  assert.equal(unanswerableInputSchema({ properties: { reason: { type: "string" } } }), null);
});

// codex, PR #65: the first draft tested for the literal string "object" and so rejected
// `{"type": ["object"], ...}` — valid JSON Schema, answerable, and a sender that was never broken.
// A corrective release must not break correct senders, so the rule asks whether `type` ADMITS an
// object, not whether it is spelled a particular way.
test("unanswerableInputSchema accepts a type ARRAY that admits an object", () => {
  const props = { properties: { reason: { type: "string" } } };
  assert.equal(unanswerableInputSchema({ type: ["object"], ...props }), null);
  assert.equal(unanswerableInputSchema({ type: ["object", "null"], ...props }), null);
});

test("unanswerableInputSchema rejects a type array that admits NO object", () => {
  const props = { properties: { reason: { type: "string" } } };
  assert.ok(unanswerableInputSchema({ type: ["string"], ...props }));
  assert.ok(unanswerableInputSchema({ type: ["string", "number"], ...props }));
});

test("unanswerableInputSchema rejects a malformed `type` keyword — it admits nothing", () => {
  // Neither a string nor an array of strings is a valid `type`, so the schema is not merely
  // unanswerable, it is uncompilable. Silently passing it would defer the failure to resolve time.
  const props = { properties: { reason: { type: "string" } } };
  assert.ok(unanswerableInputSchema({ type: 42, ...props }));
  assert.ok(unanswerableInputSchema({ type: null, ...props }));
  assert.ok(unanswerableInputSchema({ type: {}, ...props }));
});

test("unanswerableInputSchema rejects non-object schemas without throwing", () => {
  assert.ok(unanswerableInputSchema(null));
  assert.ok(unanswerableInputSchema([]));
  assert.ok(unanswerableInputSchema("string"));
});

// ---- response.edited (§6) ----

const SELECT = {
  mode: "select",
  options: [
    { value: "ship", label: "Ship" },
    { value: "hold", label: "Hold" },
  ],
};

test("edited is FALSE for a listed value and TRUE for an off-menu one", () => {
  assert.equal(isEditedAnswer(SELECT, "hold"), false);
  assert.equal(isEditedAnswer(SELECT, "hold, until the backfill lands"), true);
});

test("edited is derived from SET MEMBERSHIP, not from which affordance the human used", () => {
  // The load-bearing property: two resolutions carrying the same value against the same options
  // always agree, so the agent can recompute `edited` from request.options + value and verify the
  // Hub rather than trust it. A Hub tracking UI state could not offer that guarantee — a human who
  // typed "hold" by hand into a free-form box still chose a listed option, and says so.
  assert.equal(isEditedAnswer(SELECT, "ship"), isEditedAnswer(SELECT, "ship"));
  assert.equal(isEditedAnswer(SELECT, "ship"), false);
});

test("edited is FALSE for an input-mode object answer — there are no options to be outside of", () => {
  assert.equal(isEditedAnswer({ mode: "input" }, { reason: "because" }), false);
  assert.equal(isEditedAnswer(SELECT, { reason: "because" }), false);
});

// codex, PR #65: the case the first draft got WRONG. §5.2 makes `confirm` sugar — with `options`
// omitted the Hub synthesizes `approve`/`deny` — so membership has to be tested against the
// EFFECTIVE set. Reading `request.options` alone returned false for a genuinely off-menu answer,
// i.e. the flag lying in exactly the direction it exists to prevent.
test("edited respects a confirm's SYNTHESIZED approve/deny when options are omitted", () => {
  const confirm = { mode: "confirm" };
  assert.equal(isEditedAnswer(confirm, "approve"), false);
  assert.equal(isEditedAnswer(confirm, "deny"), false);
  assert.equal(isEditedAnswer(confirm, "later"), true); // off-menu, and must say so
});

test("a confirm that SUPPLIES its two options is measured against those, not the synthesized pair", () => {
  const confirm = { mode: "confirm", options: [{ value: "yes" }, { value: "no" }] };
  assert.equal(isEditedAnswer(confirm, "yes"), false);
  // `approve` is the synthesized default's value, but this ask never offered it.
  assert.equal(isEditedAnswer(confirm, "approve"), true);
});

test("effectiveOptions synthesizes only for confirm, and only when options are absent", () => {
  assert.deepEqual(
    effectiveOptions({ mode: "confirm" })?.map((o) => o.value),
    ["approve", "deny"],
  );
  assert.equal(effectiveOptions({ mode: "select" }), null);
  assert.equal(effectiveOptions({ mode: "input" }), null);
  assert.equal(effectiveOptions(undefined), null);
  // An explicitly EMPTY array is a set, not an absent one — never silently replaced.
  assert.deepEqual(effectiveOptions({ mode: "confirm", options: [] }), []);
});

test("edited is case- and whitespace-sensitive: membership is exact string equality", () => {
  // Deliberate. A near-miss is NOT the listed option, and silently coercing it to one would
  // fabricate a choice the human did not make — the exact failure the flag exists to surface.
  assert.equal(isEditedAnswer(SELECT, "Ship"), true);
  assert.equal(isEditedAnswer(SELECT, "ship "), true);
});
