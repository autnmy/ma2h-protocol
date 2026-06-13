// The reference validator (ajv over the published schemas) must accept every
// example and reject the negative cases — tying the impl to the conformance set.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateMessage, validateResponse } from "../src/envelope.js";

const load = (f: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../examples/${f}`, import.meta.url), "utf8"));

const messageExamples = [
  "notify-daily-digest",
  "ask-dev-team-decision",
  "task-manual-action",
  "ask-mode-input",
  "ask-mode-confirm",
  "ask-sensitive-field",
  "callback-agent-resume",
];
const responseExamples = [
  "response",
  "response-expired-default",
  "response-cancelled",
  "response-declined",
  "task-completion-response",
];

for (const f of messageExamples) {
  test(`example ${f} validates as a message`, () => {
    assert.deepEqual(validateMessage(load(`${f}.json`)), { valid: true });
  });
}
for (const f of responseExamples) {
  test(`example ${f} validates as a response`, () => {
    assert.deepEqual(validateResponse(load(`${f}.json`)), { valid: true });
  });
}

test("a notify carrying a request block is rejected", () => {
  const r = validateMessage({
    a2h_version: "0.3",
    type: "notify",
    created_at: "2026-06-04T13:00:00Z",
    agent: { id: "a", run_id: "r", runtime: "cloud" },
    title: "x",
    request: { mode: "confirm" },
  });
  assert.equal(r.valid, false);
});

test("an ask without idempotency_key is rejected", () => {
  const r = validateMessage({
    a2h_version: "0.3",
    type: "ask",
    created_at: "2026-06-04T13:00:00Z",
    agent: { id: "a", run_id: "r", runtime: "cli" },
    title: "x",
    request: { mode: "select", options: [{ value: "a", label: "A" }] },
  });
  assert.equal(r.valid, false);
});

test("a response with resolution 'ignored' is rejected", () => {
  const r = validateResponse({
    a2h_version: "0.3",
    in_reply_to: "msg_1",
    resolution_id: "res_1",
    agent: { id: "a", run_id: "r" },
    resolution: "ignored",
    response: { actor: "human:x", resolved_at: "2026-06-04T13:00:00Z" },
  });
  assert.equal(r.valid, false);
});
