// The v0.6 `ask` contract, proven BEHAVIORALLY against the reference Hub — obligations dp-026,
// dp-027, dp-028 and dp-029 (spec §5.2, §6, §8.8).
//
// These exist because a schema cannot reach any of it: `options[].value` uniqueness has no JSON
// Schema keyword, the answerability RULE is about what the Hub refuses to create, `edited` relates a
// resolve value to the ORIGINATING request, and dp-029 is about which declared minors a rule binds
// at. A review of the first draft found the Hub advertising v0.6 while enforcing none of it — the
// vectors were obligations with no implementation behind them. This file is what makes that
// impossible to repeat.

import test from "node:test";
import assert from "node:assert/strict";
import { Hub, HubError } from "../src/hub.js";
import type { A2hMessage, AskRequest } from "../src/types.js";

const SIGNING_KEY = "hub-signing-key-0123456789abcdef0123456789abcdef";
const T0 = 1_750_000_000_000;

const newHub = (): Hub => new Hub({ signingKey: SIGNING_KEY, now: () => T0 });

let seq = 0;
function ask(request: AskRequest, version = "0.6"): A2hMessage {
  seq += 1;
  return {
    ma2h_version: version,
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: "deploybot/dev-team", run_id: "run_1", runtime: "cli" },
    title: "Ship or hold?",
    idempotency_key: `idem-${seq}`,
    // §9.1 fails closed: without an explicit human resolver the only permitted actor is the
    // submitting agent, so every resolve below would 403 before reaching the rule under test.
    request: { allowed_resolvers: ["human:alice"], ...request },
  } as A2hMessage;
}

const isCode = (code: string) => (e: unknown) => e instanceof HubError && e.code === code;

const SHIP_HOLD = [
  { value: "ship", label: "Ship" },
  { value: "hold", label: "Hold" },
];

// ---- dp-026: options[].value uniqueness ----

test("dp-026: a duplicate options[].value is REJECTED at submit, and no message is created", () => {
  const hub = newHub();
  const dupe = ask({
    mode: "select",
    options: [
      { value: "approve", label: "Approve and deploy" },
      { value: "approve", label: "Approve but hold" },
    ],
  });
  assert.throws(() => hub.submit(dupe), isCode("invalid_field"));
  // The negative half: refusing must not leave a half-created message behind. A refused submit
  // never returns an id, so the check is that a REPLAY of the same idempotency_key is treated as a
  // first submit rather than a duplicate — i.e. nothing was recorded under it.
  const retry = ask({ mode: "select", options: SHIP_HOLD });
  (retry as { idempotency_key: string }).idempotency_key = (dupe as { idempotency_key: string })
    .idempotency_key;
  assert.equal(hub.submit(retry).status, "open");
});

test("dp-026: duplicate LABELS are fine — only `value` has to discriminate", () => {
  const hub = newHub();
  const { id } = hub.submit(
    ask({
      mode: "select",
      options: [
        { value: "ship", label: "Go", description: "same words" },
        { value: "hold", label: "Go", description: "same words" },
      ],
    }),
  );
  assert.ok(id);
});

// ---- dp-027: input-schema answerability ----

test("dp-027: a SCALAR input schema is refused at submit, not deferred to resolve", () => {
  const hub = newHub();
  assert.throws(
    () => hub.submit(ask({ mode: "input", schema: { type: "string", minLength: 1 } })),
    isCode("invalid_field"),
  );
});

test("dp-027: an input schema with no `properties` is refused too", () => {
  const hub = newHub();
  assert.throws(() => hub.submit(ask({ mode: "input", schema: { type: "object" } })), isCode("invalid_field"));
});

test("dp-027: an answer-object schema is accepted, including a `type` ARRAY that admits an object", () => {
  const hub = newHub();
  assert.ok(
    hub.submit(ask({ mode: "input", schema: { type: "object", properties: { reason: { type: "string" } } } })).id,
  );
  // `["object","null"]` is legitimate JSON Schema and answerable — a corrective release must not
  // break a sender that was never broken.
  assert.ok(
    hub.submit(ask({ mode: "input", schema: { type: ["object", "null"], properties: { r: { type: "string" } } } }))
      .id,
  );
});

test("dp-027: a select carrying a stray `schema` is UNAFFECTED — the rule is scoped to mode=input", () => {
  const hub = newHub();
  assert.ok(hub.submit(ask({ mode: "select", options: SHIP_HOLD, schema: {} } as AskRequest)).id);
});

// ---- dp-029: the corrections bind at EVERY declared minor ----

for (const version of ["0.3", "0.4", "0.5", "0.6"]) {
  test(`dp-029: both corrections are enforced at ma2h_version ${version}`, () => {
    const hub = newHub();
    assert.throws(
      () => hub.submit(ask({ mode: "input", schema: { type: "string" } }, version)),
      isCode("invalid_field"),
      `scalar input schema must be refused at ${version}`,
    );
    assert.throws(
      () =>
        hub.submit(
          ask({ mode: "select", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] }, version),
        ),
      isCode("invalid_field"),
      `duplicate option value must be refused at ${version}`,
    );
  });
}

// ---- dp-028 + dp-029: allow_edit IS gated, and edited is Hub-computed ----

function resolveWith(hub: Hub, id: string, value: string): void {
  hub.resolve(id, { actor: "human:alice", resolution: "answered", value });
}

/** The stored Response detail for a resolved ask, via the submitting agent's own pull read. */
function detail(hub: Hub, id: string) {
  return hub.get(id, "deploybot/dev-team")?.response?.response;
}

test("dp-028: without allow_edit, an off-menu value is refused and the ask stays open", () => {
  const hub = newHub();
  const { id } = hub.submit(ask({ mode: "select", options: SHIP_HOLD }));
  assert.throws(() => resolveWith(hub, id, "hold, until the migration lands"), isCode("invalid_field"));
  assert.equal(hub.get(id, "deploybot/dev-team")?.status, "open");
});

test("dp-028: with allow_edit, the off-menu value is accepted verbatim and carries edited:true", () => {
  const hub = newHub();
  const { id } = hub.submit(
    ask({ mode: "select", options: SHIP_HOLD, permissions: { allow_edit: true } }),
  );
  resolveWith(hub, id, "hold, until the migration lands");
  assert.equal(detail(hub, id)?.value, "hold, until the migration lands");
  assert.equal(detail(hub, id)?.edited, true);
});

test("dp-028: a LISTED value under allow_edit carries edited:false — membership, not affordance", () => {
  const hub = newHub();
  const { id } = hub.submit(ask({ mode: "select", options: SHIP_HOLD, permissions: { allow_edit: true } }));
  resolveWith(hub, id, "hold");
  // Emitted only when true, so "not true" is the assertion — an ordinary answer carries no field.
  assert.notEqual(detail(hub, id)?.edited, true);
});

test("dp-028: a resolver-supplied `edited` is IGNORED — the Hub computes it", () => {
  const hub = newHub();
  const { id } = hub.submit(ask({ mode: "select", options: SHIP_HOLD, permissions: { allow_edit: true } }));
  hub.resolve(id, {
    actor: "human:alice",
    resolution: "answered",
    value: "ship",
    edited: true,
  } as never);
  assert.notEqual(detail(hub, id)?.edited, true);
});

test("dp-028: a confirm with OMITTED options measures against the synthesized approve/deny", () => {
  const hub = newHub();
  const { id } = hub.submit(ask({ mode: "confirm", permissions: { allow_edit: true } }));
  resolveWith(hub, id, "later");
  // The case the first draft got wrong: with no `options` array there was nothing to be outside of,
  // so a genuinely off-menu answer came back edited:false — the flag lying in the one direction it
  // exists to prevent.
  assert.equal(detail(hub, id)?.edited, true);

  const second = hub.submit(ask({ mode: "confirm", permissions: { allow_edit: true } }));
  resolveWith(hub, second.id, "approve");
  assert.notEqual(detail(hub, second.id)?.edited, true);
});

test("dp-029: allow_edit buys nothing at 0.5 — the gate reads the STORED version", () => {
  const hub = newHub();
  const envelope = ask({ mode: "select", options: SHIP_HOLD, permissions: { allow_edit: true } }, "0.5");
  const { id } = hub.submit(envelope);
  // Accepted (robustness — a field the declared version does not have is ignored, not rejected)...
  assert.equal(hub.get(id, "deploybot/dev-team")?.status, "open");
  // ...but it bought nothing: membership is still enforced at resolve.
  assert.throws(() => resolveWith(hub, id, "something else entirely"), isCode("invalid_field"));
});

test("dp-029: the envelope is stored VERBATIM — the gate must not rewrite what the sender said", () => {
  // §5.2 forbids implementing the gate by stripping. Two reasons, and this pins the mechanism that
  // avoids both: a stripping Hub reaches only messages accepted AFTER it upgraded (every ask already
  // stored keeps the field), and it mutates the payload §8.1 hashes, so a byte-identical retry of a
  // pre-upgrade ask answers 409 instead of recovering the original ack.
  const hub = newHub();
  const envelope = ask({ mode: "select", options: SHIP_HOLD, permissions: { allow_edit: true } }, "0.5");
  const { id } = hub.submit(envelope);

  // Read through `unknown`: `get` returns the discriminated envelope union, and `request` lives only
  // on the ask branch. The point of the assertion is the STORED BYTES, so reaching them structurally
  // is honest here in a way a type-level narrow would obscure.
  const stored = hub.get(id, "deploybot/dev-team") as unknown as
    | { request?: { permissions?: { allow_edit?: unknown } } }
    | null;
  assert.equal(
    stored?.request?.permissions?.allow_edit,
    true,
    "the field survives storage untouched — only its EFFECT is gated",
  );
});

test("dp-028: allow_edit does NOT relax default_on_expire — that is the agent's fallback, not a human answer", () => {
  const hub = newHub();
  assert.throws(
    () =>
      hub.submit(
        ask({
          mode: "select",
          options: SHIP_HOLD,
          permissions: { allow_edit: true },
          default_on_expire: "not a listed value",
        }),
      ),
    isCode("invalid_field"),
  );
});
