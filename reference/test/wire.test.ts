// U3 + U4 (issue #45): the wire.ts envelope builders and the canonical version-stamp rule, then
// the wire validators — §8.1 ack/misroute, the per-type status tables and poll checks, the
// drain-batch shape guard, the strip-duty field rules, and the §8.5 error reading.
//
// Every version assertion here is a STRING LITERAL on purpose — never `MA2H_VERSION`. The rule's
// arms are static properties of the envelope's features (the oh-hai#712 class), so the pins must
// not float with the implementation's current version: at the v0.6 bump these tests still demand
// "0.3"/"0.5" from the same inputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  ADDRESSED_NOTIFY_STATUSES,
  ASK_STATUSES,
  buildAsk,
  buildNotify,
  buildTask,
  classifyHubError,
  DIRECTIVE_KEEP_FIELDS,
  effectiveCode,
  ENTRY_KINDS,
  HUMAN_INBOX_NOTIFY_STATUSES,
  MESSAGE_ENTRY_KEEP_FIELDS,
  newIdempotencyKey,
  statusesFor,
  usesInterAgentAddressing,
  usesSessionQualifiedResolvers,
  TASK_STATUSES,
  TERMINAL_ASK_TASK_STATUSES,
  validateDrainBatch,
  validateKnownFields,
  validatePollStatus,
  validateSubmitAck,
  wireVersionFor,
  WIRE_BASE_VERSION,
  WIRE_FEATURES,
  type AskInput,
  type HubErrorClass,
  type HubErrorReading,
  type TaskInput,
} from "../src/wire.js";
import {
  computeDirectivePayloadSha256,
  computeMessageEntryPayloadSha256,
  DIRECTIVE_CONTENT_FIELDS,
  MESSAGE_ENTRY_CONTENT_FIELDS,
  SIGNED_FIELDS,
  SIGNED_INBOUND_FIELDS,
  SIGNED_MESSAGE_ENTRY_FIELDS,
  SIGNED_RECEIPT_FIELDS,
  SIGNED_RESPONSE_ENTRY_FIELDS,
} from "../src/signing.js";
import { canonicalize } from "../src/canonicalize.js";
import { validateMessage, validateV05 } from "../src/envelope.js";
import type { AgentDescriptor, AskRequest, InboundDirective, InterAgentMessage, TaskAction } from "../src/types.js";

const AGENT: AgentDescriptor = { id: "wire-bot", run_id: "run_1", runtime: "cli" };
const FIXED_NOW = "2026-08-13T12:00:00.000Z";
const clock = (): Date => new Date(FIXED_NOW);
const MINIMAL_REQUEST: AskRequest = { mode: "select", options: [{ value: "ok", label: "OK" }] };

// ---- The version-stamp rule (both arms pinned by literal) ----

test("the rule's arms are the module's own literals: base \"0.3\", inter-agent minima \"0.5\"", () => {
  assert.equal(WIRE_BASE_VERSION, "0.3");
  assert.equal(WIRE_FEATURES.interAgentEnvelope.minimum, "0.5");
  assert.equal(WIRE_FEATURES.sessionQualifiedResolvers.minimum, "0.5");
});

test("non-addressed notify stamps \"0.3\" and never carries an idempotency_key", () => {
  const notify = buildNotify({ agent: AGENT, title: "digest" }, clock);
  assert.equal(notify.ma2h_version, "0.3");
  assert.equal(notify.created_at, FIXED_NOW, "created_at comes from the injected clock");
  assert.equal("idempotency_key" in notify, false, "notify never carries one (wire.ts contract)");
});

test("`to` makes the envelope addressed → stamps \"0.5\"", () => {
  const notify = buildNotify({ agent: AGENT, title: "ping", to: "agent:peer" }, clock);
  assert.equal(notify.ma2h_version, "0.5");
});

test("`agent.session` alone makes the envelope addressed → stamps \"0.5\"", () => {
  const notify = buildNotify({ agent: { ...AGENT, session: "sess_me" }, title: "ping" }, clock);
  assert.equal(notify.ma2h_version, "0.5");
});

test("usesInterAgentAddressing: `to` present or `agent.session` present, nothing else", () => {
  assert.equal(usesInterAgentAddressing({ agent: AGENT }), false);
  assert.equal(usesInterAgentAddressing({ agent: AGENT, to: "agent:peer" }), true);
  assert.equal(usesInterAgentAddressing({ agent: { ...AGENT, session: "sess_me" } }), true);
  assert.equal(wireVersionFor({ agent: AGENT }), "0.3");
  assert.equal(wireVersionFor({ agent: AGENT, to: "agent:peer#sess_p" }), "0.5");
});

// ---- Schema validity via envelope.ts (v0.4 registry; v0.5 when addressed — no v0.3 registry exists) ----

test("non-addressed builder output validates against the v0.4 registry", () => {
  const notify = buildNotify({ agent: AGENT, title: "digest", body: "all green" }, clock);
  const ask = buildAsk(
    { agent: AGENT, title: "ship?", idempotency_key: newIdempotencyKey(), request: MINIMAL_REQUEST },
    clock,
  );
  const task = buildTask(
    { agent: AGENT, title: "rotate", idempotency_key: newIdempotencyKey(), action: { instructions: "rotate the key" } },
    clock,
  );
  for (const [kind, message] of [["notify", notify], ["ask", ask], ["task", task]] as const) {
    const result = validateMessage(message);
    assert.equal(result.valid, true, `${kind}: ${JSON.stringify(result)}`);
  }
});

test("addressed builder output validates against the v0.5 registry", () => {
  const notify = buildNotify({ agent: { ...AGENT, session: "sess_me" }, title: "ping", to: "agent:peer" }, clock);
  const ask = buildAsk(
    {
      agent: { ...AGENT, session: "sess_me" },
      to: "agent:peer#sess_peer",
      title: "approve?",
      idempotency_key: newIdempotencyKey(),
      request: MINIMAL_REQUEST,
    },
    clock,
  );
  for (const [kind, message] of [["notify", notify], ["ask", ask]] as const) {
    assert.equal(message.ma2h_version, "0.5");
    const result = validateV05("message.schema.json", message);
    assert.equal(result.valid, true, `${kind}: ${JSON.stringify(result)}`);
  }
});

// ---- Idempotency keys (KTD1b: mint-once-reuse) ----

test("minted keys are unique and idem_-prefixed", () => {
  const keys = Array.from({ length: 200 }, () => newIdempotencyKey());
  assert.equal(new Set(keys).size, keys.length, "every mint is unique");
  for (const key of keys) assert.match(key, /^idem_/);
});

test("a caller-supplied key round-trips verbatim (the builders never mint silently)", () => {
  const key = newIdempotencyKey();
  const ask = buildAsk({ agent: AGENT, title: "t", idempotency_key: key, request: MINIMAL_REQUEST }, clock);
  const task = buildTask({ agent: AGENT, title: "t", idempotency_key: key, action: { instructions: "x" } }, clock);
  assert.equal(ask.idempotency_key, key);
  assert.equal(task.idempotency_key, key);
});

test("ask/task input types REQUIRE idempotency_key (compile-level)", () => {
  // The real assertion is the two @ts-expect-error lines: `npm run typecheck` fails if either
  // call ever compiles WITHOUT the key (i.e. if the requirement is loosened).
  // @ts-expect-error — AskInput without idempotency_key must not compile (KTD1b).
  const badAsk: AskInput = { agent: AGENT, title: "t", request: MINIMAL_REQUEST };
  // @ts-expect-error — TaskInput without idempotency_key must not compile (KTD1b).
  const badTask: TaskInput = { agent: AGENT, title: "t", action: { instructions: "x" } };
  void badAsk;
  void badTask;
  assert.ok(true);
});

// ---- The full optional surface (the playground's sealed-state ask is the model) ----

test("a full-surface ask validates: sealed state, complete request, expiry, every optional", () => {
  const ask = buildAsk(
    {
      agent: { ...AGENT, project: "demo", labels: { team: "infra" } },
      title: "Ship the candidate build to prod, or hold?",
      idempotency_key: newIdempotencyKey(),
      body: "CI is green. Ship now, or hold for review?",
      priority: "high",
      tags: ["deploy", "prod"],
      context: [{ kind: "text", text: "build abc123def" }],
      state: { sealed: "v1.9pXm2kQw.aGVsbG8gd29ybGQ" }, // sealed-looking, opaque to the Hub (§9.3)
      client_ref: "ref-42",
      expires_at: "2026-08-13T13:00:00.000Z",
      sensitive: true,
      request: {
        mode: "select",
        options: [
          { value: "ship", label: "Ship to prod now" },
          { value: "hold", label: "Hold for review" },
        ],
        permissions: { allow_respond: true, allow_ignore: false },
        default_on_expire: "hold",
        allowed_resolvers: ["human:you"],
        callback: { mode: "push", url: "https://bot.example/resume", auth: { scheme: "hmac", secret_ref: "env:K" } },
      },
    },
    clock,
  );
  assert.equal(ask.ma2h_version, "0.3", "nothing here needs more than the base minor");
  const result = validateMessage(ask);
  assert.equal(result.valid, true, JSON.stringify(result));
});

test("a full-surface addressed task validates against v0.5", () => {
  const task = buildTask(
    {
      agent: { ...AGENT, session: "sess_me" },
      to: "agent:peer#sess_peer",
      title: "Rotate the API key",
      idempotency_key: newIdempotencyKey(),
      action: {
        instructions: "Rotate the key and confirm the old one is rejected.",
        checklist: [{ text: "open console" }, { text: "rotate", done: false }],
        verification: "old key returns 401",
        allowed_resolvers: ["agent:peer#sess_peer"],
        callback: { mode: "pull" },
      },
    },
    clock,
  );
  assert.equal(task.ma2h_version, "0.5");
  const result = validateV05("message.schema.json", task);
  assert.equal(result.valid, true, JSON.stringify(result));
});

test("empty tags are omitted from the wire", () => {
  const notify = buildNotify({ agent: AGENT, title: "t", tags: [] }, clock);
  assert.equal("tags" in notify, false);
});

// ---- The first in-repo consumer ----

test("demo/playground.ts executes end-to-end on the builders", async () => {
  const referenceDir = fileURLToPath(new URL("..", import.meta.url));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "demo/playground.ts"], {
        cwd: referenceDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => { resolve({ code, stdout, stderr }); });
      // The demo's first await is the readline question, so this line is consumed by it.
      child.stdin.write("ship\n");
      child.stdin.end();
    },
  );
  assert.equal(result.code, 0, `playground exited ${String(result.code)}:\n${result.stderr}`);
  assert.match(result.stdout, /DEPLOYING/, "the ship decision was verified and acted on");
  assert.match(result.stdout, /acted=false/, "the replay rejection still demonstrates");
});

// ==== U4: the wire validators (issue #45, R6–R10) ====

const POLL_URL = "https://hub.example/v1/messages/msg_01";

// ---- §8.1 submit-ack validation and the addressed-misroute detector (R6) ----

test("§8.1 ack: a minimal valid ack passes and comes back typed", () => {
  const result = validateSubmitAck({ id: "m_01", status: "open", poll_url: POLL_URL }, { addressed: false });
  assert.equal(result.valid, true);
  if (!result.valid) assert.fail("expected valid");
  assert.equal(result.ack.id, "m_01");
  assert.equal(result.ack.status, "open");
  assert.equal(result.ack.poll_url, POLL_URL);
  assert.equal("destination" in result.ack, false);
});

test("§8.1 ack: a missing poll_url fails (and is not a misroute)", () => {
  const result = validateSubmitAck({ id: "m_01", status: "open" }, { addressed: true });
  assert.equal(result.valid, false);
  if (result.valid) assert.fail("expected invalid");
  assert.equal(result.misroute, false, "a broken base ack says nothing about routing");
  assert.ok(result.errors.some((e) => e.includes("poll_url")), JSON.stringify(result.errors));
});

test("misroute detector: an addressed submit acked WITHOUT a destination snapshot is a structured failure carrying the accepted id", () => {
  // The pre-0.5 misroute in the flesh: the Hub accepted the addressed notify but treated it as a
  // human-inbox notify (status `delivered`, no snapshot). The SCHEMA cannot catch this — the body
  // is a perfectly valid human-inbox ack — which is exactly why the detector is client-side (§8.1:
  // the sender knows it addressed the message).
  const ack = { id: "legacy_7", status: "delivered", poll_url: POLL_URL };
  assert.equal(validateV05("submit-ack.schema.json", ack).valid, true, "schema-valid — only context can catch it");
  const result = validateSubmitAck(ack, { addressed: true });
  assert.equal(result.valid, false);
  if (result.valid) assert.fail("expected invalid");
  assert.equal(result.misroute, true);
  if (!result.misroute) assert.fail("expected misroute");
  assert.equal(result.acceptedId, "legacy_7", "the accepted id rides the failure so the sender can cancel/track it");

  // The SAME body on a non-addressed submit is simply a valid ack — the context is the detector.
  assert.equal(validateSubmitAck(ack, { addressed: false }).valid, true);
});

test("§8.1 ack: a valid destination snapshot passes — known state with last_seen, or exactly {state:\"unknown\"}", () => {
  const online = validateSubmitAck(
    {
      id: "msg_01",
      status: "queued",
      poll_url: POLL_URL,
      destination: { state: "online", last_seen: "2026-08-13T11:59:00Z" },
    },
    { addressed: true },
  );
  assert.equal(online.valid, true, JSON.stringify(online));
  if (!online.valid) assert.fail("expected valid");
  assert.equal(online.ack.destination?.state, "online");

  const unknown = validateSubmitAck(
    { id: "msg_02", status: "open", poll_url: POLL_URL, destination: { state: "unknown" } },
    { addressed: true },
  );
  assert.equal(unknown.valid, true, JSON.stringify(unknown));
});

test("schema delegation proves the snapshot rules: a 4-state `idle` fails, and a known state without last_seen fails its pairing", () => {
  // Neither the 3-state enum nor the last_seen pairing is re-derived in wire.ts — both verdicts
  // come from validateV05("submit-ack.schema.json", …), mapped into the structured misroute result
  // (MCP's 4-state `idle` acceptance dies here, not accommodated).
  const idle = validateSubmitAck(
    { id: "msg_03", status: "queued", poll_url: POLL_URL, destination: { state: "idle" } },
    { addressed: true },
  );
  assert.equal(idle.valid, false);
  if (idle.valid) assert.fail("expected invalid");
  assert.equal(idle.misroute, true, "an invalid snapshot on an addressed ack is the misroute failure");
  if (!idle.misroute) assert.fail("expected misroute");
  assert.equal(idle.acceptedId, "msg_03");
  assert.ok(idle.errors.some((e) => e.startsWith("/destination")), JSON.stringify(idle.errors));

  const unpaired = validateSubmitAck(
    { id: "msg_04", status: "queued", poll_url: POLL_URL, destination: { state: "online" } },
    { addressed: true },
  );
  assert.equal(unpaired.valid, false);
  if (unpaired.valid) assert.fail("expected invalid");
  assert.equal(unpaired.misroute, true);

  // On a NON-addressed submit the same schema verdict surfaces as a plain invalid ack, never a
  // misroute — the addressed context is the only new logic on top of the schema.
  const nonAddressed = validateSubmitAck(
    { id: "msg_03", status: "open", poll_url: POLL_URL, destination: { state: "idle" } },
    { addressed: false },
  );
  assert.equal(nonAddressed.valid, false);
  if (nonAddressed.valid) assert.fail("expected invalid");
  assert.equal(nonAddressed.misroute, false);
});

// ---- Per-type status tables and poll checks (R7) ----

test("status tables: `delivered` is valid for an addressed notify (and queued/acknowledged/bounced ride the §14.2 track)", () => {
  for (const status of ["queued", "delivered", "acknowledged", "bounced", "expired"]) {
    const result = validatePollStatus({ id: "msg_01", status }, { id: "msg_01", type: "notify", addressed: true });
    assert.equal(result.valid, true, `${status}: ${JSON.stringify(result)}`);
  }
  // …while a HUMAN-INBOX notify knows only delivered-on-acceptance (§5.1).
  assert.equal(
    validatePollStatus({ id: "msg_01", status: "queued" }, { id: "msg_01", type: "notify", addressed: false }).valid,
    false,
    "queued is not a human-inbox notify status",
  );
});

test("status tables: `expired` is valid for an ask WITH the embedded Response present", () => {
  const result = validatePollStatus(
    { id: "msg_01", status: "expired", response: { resolution: "expired" } },
    { id: "msg_01", type: "ask", addressed: false },
  );
  assert.equal(result.valid, true, JSON.stringify(result));
});

test("status tables: `queued` is invalid for an ask — mailbox states never appear on the §7 resolution track", () => {
  const result = validatePollStatus({ id: "msg_01", status: "queued" }, { id: "msg_01", type: "ask", addressed: true });
  assert.equal(result.valid, false);
  if (result.valid) assert.fail("expected invalid");
  assert.ok(result.errors.some((e) => e.includes("queued")), JSON.stringify(result.errors));
});

test("poll checks: every terminal ask/task status WITHOUT the embedded Response fails (§8.2); `open` needs none", () => {
  assert.equal(TERMINAL_ASK_TASK_STATUSES.length, 6, "the schema's conditional covers exactly six terminals");
  for (const status of TERMINAL_ASK_TASK_STATUSES) {
    const type = status === "completed" || status === "dismissed" ? "task" : "ask";
    const bare = validatePollStatus({ id: "msg_01", status }, { id: "msg_01", type, addressed: false });
    assert.equal(bare.valid, false, `${type}/${status} without response must fail`);
    if (bare.valid) assert.fail("expected invalid");
    assert.ok(bare.errors.some((e) => e.includes("response")), JSON.stringify(bare.errors));
    const embedded = validatePollStatus(
      { id: "msg_01", status, response: { resolution: status } },
      { id: "msg_01", type, addressed: false },
    );
    assert.equal(embedded.valid, true, `${type}/${status} with response must pass`);
  }
  assert.equal(validatePollStatus({ id: "msg_01", status: "open" }, { id: "msg_01", type: "ask", addressed: false }).valid, true);
});

test("poll checks: the body must echo the polled id", () => {
  const result = validatePollStatus({ id: "msg_02", status: "open" }, { id: "msg_01", type: "task", addressed: false });
  assert.equal(result.valid, false);
  if (result.valid) assert.fail("expected invalid");
  assert.ok(result.errors.some((e) => e.includes("id mismatch")), JSON.stringify(result.errors));
});

// The derivation guard (R7): each exported table equals get-message.schema.json's enum per type,
// so a future schema change fails the suite BEFORE the tables can drift.

interface SchemaBranch {
  properties?: Record<string, { const?: unknown; enum?: unknown[] } | undefined>;
  required?: string[];
  not?: unknown;
}
interface SchemaConditional {
  if?: SchemaBranch & { allOf?: SchemaBranch[] };
  then?: SchemaBranch;
}
const GET_MESSAGE_SCHEMA = JSON.parse(
  readFileSync(new URL("../../schema/v0.5/get-message.schema.json", import.meta.url), "utf8"),
) as { allOf: SchemaConditional[] };

/** The one allOf entry keyed directly on `type: {const}` whose `then` constrains `status`. */
function directStatusEnum(typeName: string): unknown {
  const matches = GET_MESSAGE_SCHEMA.allOf.filter(
    (entry) =>
      entry.if?.allOf === undefined &&
      entry.if?.properties?.["type"]?.const === typeName &&
      entry.then?.properties?.["status"]?.enum !== undefined,
  );
  assert.equal(matches.length, 1, `exactly one direct ${typeName} status conditional`);
  return matches[0]?.then?.properties?.["status"]?.enum;
}

/** The notify status conditional whose `if.allOf` carries the given `to`-presence marker. */
function notifyStatusRule(toMarker: SchemaBranch): { const?: unknown; enum?: unknown[] } {
  const matches = GET_MESSAGE_SCHEMA.allOf.filter(
    (entry) =>
      entry.if?.allOf !== undefined &&
      entry.if.allOf.some((item) => item.properties?.["type"]?.const === "notify") &&
      entry.if.allOf.some((item) => isDeepStrictEqual(item, toMarker)) &&
      entry.then?.properties?.["status"] !== undefined,
  );
  assert.equal(matches.length, 1, `exactly one notify conditional for ${JSON.stringify(toMarker)}`);
  const status = matches[0]?.then?.properties?.["status"];
  assert.ok(status !== undefined);
  return status;
}

test("derivation guard: ask and task tables equal the schema's enums", () => {
  assert.deepEqual([...ASK_STATUSES], directStatusEnum("ask"));
  assert.deepEqual([...TASK_STATUSES], directStatusEnum("task"));
});

test("derivation guard: both notify tables equal the schema's `to`-split conditionals", () => {
  const humanInbox = notifyStatusRule({ not: { required: ["to"] } });
  assert.deepEqual([...HUMAN_INBOX_NOTIFY_STATUSES], [humanInbox.const], "delivered-on-acceptance is a const in the schema");
  const addressed = notifyStatusRule({ required: ["to"] });
  assert.deepEqual([...ADDRESSED_NOTIFY_STATUSES], addressed.enum);
});

test("derivation guard: the six-terminal set equals the schema's requires-Response conditional", () => {
  const matches = GET_MESSAGE_SCHEMA.allOf.filter((entry) => isDeepStrictEqual(entry.then, { required: ["response"] }));
  assert.equal(matches.length, 1, "exactly one terminal-requires-Response conditional");
  const statusItem = matches[0]?.if?.allOf?.find((item) => item.properties?.["status"]?.enum !== undefined);
  assert.ok(statusItem !== undefined, "the conditional keys on a status enum");
  assert.deepEqual([...TERMINAL_ASK_TASK_STATUSES], statusItem.properties?.["status"]?.enum);
});

test("statusesFor pairs each verb/leg with its table — ask/task identical on both legs, notify split on `to`", () => {
  assert.equal(statusesFor("ask", false), ASK_STATUSES);
  assert.equal(statusesFor("ask", true), ASK_STATUSES);
  assert.equal(statusesFor("task", false), TASK_STATUSES);
  assert.equal(statusesFor("task", true), TASK_STATUSES);
  assert.equal(statusesFor("notify", false), HUMAN_INBOX_NOTIFY_STATUSES);
  assert.equal(statusesFor("notify", true), ADDRESSED_NOTIFY_STATUSES);
});

// ---- Drain-batch shape guard (R8) ----

const SIG = "MA2H-Signature: t=1,jti=jti_x,v1=AAAA";

test("drain shape: a non-array body refuses whole", () => {
  for (const body of [{ entries: [] }, "nope", 42, null]) {
    const result = validateDrainBatch(body);
    assert.equal(result.valid, false, JSON.stringify(body));
  }
});

test("drain shape: one malformed row refuses the WHOLE batch", () => {
  const good = { message: { id: "msg_01" }, signature: SIG };
  for (const bad of [
    "not-an-object",
    { message: { id: "msg_02" } }, // no signature
    { message: { id: "msg_03" }, signature: "" }, // empty signature
    { signature: SIG }, // carries no entry kind
    { directive: { id: "dir_01" }, message: { id: "msg_04" }, signature: SIG }, // ambiguous
    { receipt: "rcpt_01", signature: SIG }, // payload not an object
  ]) {
    const result = validateDrainBatch([good, bad]);
    assert.equal(result.valid, false, `batch with ${JSON.stringify(bad)} must refuse whole`);
    if (result.valid) assert.fail("expected invalid");
    assert.ok(result.errors.some((e) => e.startsWith("entry 1:")), JSON.stringify(result.errors));
  }
});

test("drain shape: a valid mixed-kind batch passes and comes back typed", () => {
  const batch = [
    { directive: { id: "dir_01" }, signature: SIG },
    { message: { id: "msg_01" }, signature: SIG },
    { response: { in_reply_to: "msg_00" }, signature: SIG },
    { receipt: { id: "rcpt_01" }, signature: SIG },
  ];
  const result = validateDrainBatch(batch);
  assert.equal(result.valid, true, JSON.stringify(result));
  if (!result.valid) assert.fail("expected valid");
  assert.equal(result.entries.length, 4);
  assert.deepEqual(ENTRY_KINDS, ["directive", "message", "response", "receipt"]);
});

// ---- The strip-duty field rules (R10) ----

const DIRECTIVE_FIXTURE = JSON.parse(
  readFileSync(new URL("../../examples/directive-inbound.json", import.meta.url), "utf8"),
) as InboundDirective;
const MESSAGE_FIXTURE = JSON.parse(
  readFileSync(new URL("../../examples/message-inter-agent-ask.json", import.meta.url), "utf8"),
) as InterAgentMessage;

/** Independent present-field projection — deliberately NOT the helper the digest functions use. */
function pickPresent(source: object, fields: readonly string[]): Record<string, unknown> {
  const src = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (src[field] !== undefined) out[field] = src[field];
  return out;
}

test("the exported content lists ARE the digest binding — independent recompute matches the functions and the worked-example pins", () => {
  // Recompute each digest from scratch over the EXPORTED list; equality with the compute function
  // proves the list is the binding set, and equality with the examples/*.md pins proves the R10
  // iteration refactor moved no bytes.
  const directiveDigest = createHash("sha256")
    .update(canonicalize({ directive: pickPresent(DIRECTIVE_FIXTURE, DIRECTIVE_CONTENT_FIELDS) }))
    .digest("hex");
  assert.equal(directiveDigest, computeDirectivePayloadSha256(DIRECTIVE_FIXTURE));
  assert.equal(directiveDigest, "73a4c4c78425ebb286d36fe12905fab35eb07adf38166940137872b43fef0483");

  const messageDigest = createHash("sha256")
    .update(canonicalize({ message: pickPresent(MESSAGE_FIXTURE, MESSAGE_ENTRY_CONTENT_FIELDS.ask) }))
    .digest("hex");
  assert.equal(messageDigest, computeMessageEntryPayloadSha256(MESSAGE_FIXTURE));
  assert.equal(messageDigest, "f5d7fe8d3c10f59cf353375d9dd078bf36c74cb7cf503ed76fcdb2de3ad719ee");
});

test("keep-lists are NOT the content lists: they carry the delivered-but-unsigned advisory fields", () => {
  for (const advisory of ["created_at", "agent", "expires_at", "idempotency_key"]) {
    assert.ok((MESSAGE_ENTRY_KEEP_FIELDS.ask as readonly string[]).includes(advisory), `keep-list carries ${advisory}`);
    assert.ok(!(MESSAGE_ENTRY_CONTENT_FIELDS.ask as readonly string[]).includes(advisory), `digest never binds ${advisory}`);
  }
  assert.ok((DIRECTIVE_KEEP_FIELDS as readonly string[]).includes("created_at"));
  assert.ok(!(DIRECTIVE_CONTENT_FIELDS as readonly string[]).includes("created_at"));
});

test("validateKnownFields passes a clean entry of its kind", () => {
  assert.deepEqual(validateKnownFields(DIRECTIVE_FIXTURE, "directive"), { valid: true });
  assert.deepEqual(validateKnownFields(MESSAGE_FIXTURE, "ask"), { valid: true });
});

test("validateKnownFields refuses an entry carrying a field outside its kind's set", () => {
  // An unsigned `state` injected into a delivered ask entry (the Hub strips submitter machinery
  // before delivery, so on THIS surface it is an unknown field, §8.7): refuse, never forward.
  const injected = { ...MESSAGE_FIXTURE, state: { sealed: "attacker" } };
  const result = validateKnownFields(injected, "ask");
  assert.equal(result.valid, false);
  if (result.valid) assert.fail("expected invalid");
  assert.ok(result.errors.some((e) => e.includes('"state"')), JSON.stringify(result.errors));

  // A directive with a cross-type `request` bolted on: outside the directive set.
  const crossType = { ...DIRECTIVE_FIXTURE, request: { mode: "confirm" } };
  assert.equal(validateKnownFields(crossType, "directive").valid, false);

  // A kind mismatch reads as unknown fields too — an ask checked against the notify set refuses
  // on its `request`.
  assert.equal(validateKnownFields(MESSAGE_FIXTURE, "notify").valid, false);

  // Not an object at all: refused, never thrown.
  assert.equal(validateKnownFields("nope", "task").valid, false);
});

// ---- The §8.5 error reading: effectiveCode + the six-class classification (R9) ----

test("effectiveCode: recognized codes read as themselves; unrecognized ones fall back per touchpoint; code-less stays undefined", () => {
  assert.equal(effectiveCode({ code: "gone" }, "presentation"), "gone");
  assert.equal(effectiveCode({ code: "session_lease_revoked", status: 410 }, "presentation"), "gone");
  assert.equal(effectiveCode({ code: "session_lease_revoked", status: 410 }, "session-lifecycle"), undefined);
  assert.equal(effectiveCode({ status: 410 }, "presentation"), undefined);
  assert.equal(effectiveCode({ code: "" , status: 401 }, "presentation"), undefined);
});

test("§8.5 classification: the kill-switch outranks its own 410 class — operator-close, never own-terminal", () => {
  const reading = classifyHubError({ code: "session_closed_by_operator", status: 410 }, "presentation");
  assert.deepEqual(reading, { class: "operator-close", code: "session_closed_by_operator" });
});

test("§8.5 classification: an unrecognized 410 reads own-terminal at presentation, but propagate at session-lifecycle", () => {
  const peer = { code: "session_lease_revoked", status: 410 };
  assert.deepEqual(classifyHubError(peer, "presentation"), { class: "own-terminal", code: "gone" });
  // §8.5 gives the 410 class no reading at a session-lifecycle call (register/close) — the same
  // error must pass through as itself rather than acquire a lapsed-lease reading it never earned.
  assert.deepEqual(classifyHubError(peer, "session-lifecycle"), { class: "propagate" });
});

test("§8.5 classification: the credential classes read auth at every touchpoint", () => {
  for (const code of ["unauthenticated", "not_authorized", "agent_id_mismatch"] as const) {
    assert.deepEqual(classifyHubError({ code }, "session-lifecycle"), { class: "auth", code });
  }
  assert.deepEqual(classifyHubError({ code: "credential_needs_rotation", status: 401 }, "presentation"), {
    class: "auth",
    code: "unauthenticated",
  });
  assert.deepEqual(classifyHubError({ code: "credential_needs_rotation", status: 403 }, "session-lifecycle"), {
    class: "auth",
    code: "not_authorized",
  });
});

test("§8.5 classification: `propagate` covers recognized-but-unmapped codes, which pass through AS THEMSELVES", () => {
  for (const code of ["not_found", "rate_limited", "destination_gone", "validation_error"] as const) {
    assert.deepEqual(classifyHubError({ code }, "presentation"), { class: "propagate", code });
  }
});

test("§8.5 classification: `propagate` also covers unrecognized codes §8.5 gives no reading — never `unreadable`", () => {
  // A readable-but-unreadworthy code must not be labeled unreadable: no status, a class outside
  // §8.5's eight, and a blank fallback cell all propagate with the raw code preserved on the error.
  assert.deepEqual(classifyHubError({ code: "hub_specific_refinement" }, "presentation"), { class: "propagate" });
  assert.deepEqual(classifyHubError({ code: "hub_specific_refinement", status: 500 }, "presentation"), { class: "propagate" });
});

test("§8.5 classification: `unreadable` is strictly the code-less/malformed case", () => {
  assert.deepEqual(classifyHubError({ status: 410, message: "malformed hub response" }, "presentation"), { class: "unreadable" });
  assert.deepEqual(classifyHubError({ code: "", status: 401 }, "presentation"), { class: "unreadable" });
  assert.deepEqual(classifyHubError({ code: 410, status: 410 }, "presentation"), { class: "unreadable" });
  assert.deepEqual(classifyHubError(null, "presentation"), { class: "unreadable" });
  assert.deepEqual(classifyHubError("gone", "presentation"), { class: "unreadable" });
});

test("§8.5 classification: `already_terminal` — literal or via an unrecognized 409 at presentation — is the lost CAS race", () => {
  assert.deepEqual(classifyHubError({ code: "already_terminal" }, "presentation"), {
    class: "lost-cas-race",
    code: "already_terminal",
  });
  assert.deepEqual(classifyHubError({ code: "resolution_superseded", status: 409 }, "presentation"), {
    class: "lost-cas-race",
    code: "already_terminal",
  });
  // The same unrecognized 409 at a SUBMIT touchpoint reads idempotency_conflict — recognized but
  // unmapped, so it propagates (the touchpoint is part of the reading, §8.5).
  assert.deepEqual(classifyHubError({ code: "resolution_superseded", status: 409 }, "own-session-submit"), {
    class: "propagate",
    code: "idempotency_conflict",
  });
});

test("the six-class vocabulary is fully reachable — every class observed from a real reading", () => {
  const observed = new Set<HubErrorClass>([
    classifyHubError({ code: "unauthenticated" }, "presentation").class,
    classifyHubError({ code: "session_closed_by_operator" }, "presentation").class,
    classifyHubError({ code: "gone" }, "presentation").class,
    classifyHubError({ code: "already_terminal" }, "presentation").class,
    classifyHubError({ code: "not_found" }, "presentation").class,
    classifyHubError({ status: 410 }, "presentation").class,
  ]);
  assert.deepEqual(
    [...observed].sort(),
    ["auth", "lost-cas-race", "operator-close", "own-terminal", "propagate", "unreadable"],
  );
});

// ==== Review-fix batch (issue #45): the consolidated hardening additions ====

// ---- The sessionQualifiedResolvers feature row (version-stamp rule, second arm) ----

test("session-qualified allowed_resolvers alone lift the stamp to \"0.5\" — request side, task side, and the predicate directly", () => {
  const ask = buildAsk(
    {
      agent: AGENT,
      title: "peer approval",
      idempotency_key: newIdempotencyKey(),
      request: { ...MINIMAL_REQUEST, allowed_resolvers: ["agent:peer#sess_p"] },
    },
    clock,
  );
  assert.equal(ask.ma2h_version, "0.5", "a session-qualified resolver commits the envelope to minor 5");
  assert.equal(validateV05("message.schema.json", ask).valid, true);

  const task = buildTask(
    {
      agent: AGENT,
      title: "rotate",
      idempotency_key: newIdempotencyKey(),
      action: { instructions: "rotate the key", allowed_resolvers: ["agent:peer#sess_p"] },
    },
    clock,
  );
  assert.equal(task.ma2h_version, "0.5");

  assert.equal(usesSessionQualifiedResolvers({ agent: AGENT, request: { allowed_resolvers: ["agent:peer#sess_p"] } }), true);
  assert.equal(usesSessionQualifiedResolvers({ agent: AGENT, action: { allowed_resolvers: ["agent:peer#sess_p"] } }), true);
  // Non-lifting: human/system resolvers (even hash-bearing), bare agent principals, no surface at all.
  assert.equal(usesSessionQualifiedResolvers({ agent: AGENT, request: { allowed_resolvers: ["human:you", "agent:peer"] } }), false);
  assert.equal(usesSessionQualifiedResolvers({ agent: AGENT, request: { allowed_resolvers: ["human:you#legacy"] } }), false);
  assert.equal(usesSessionQualifiedResolvers({ agent: AGENT }), false);
});

test("a plain ask naming only human resolvers still stamps \"0.3\"", () => {
  const plain = buildAsk(
    {
      agent: AGENT,
      title: "ship?",
      idempotency_key: newIdempotencyKey(),
      request: { ...MINIMAL_REQUEST, allowed_resolvers: ["human:you"] },
    },
    clock,
  );
  assert.equal(plain.ma2h_version, "0.3");
  assert.equal(validateMessage(plain).valid, true);
});

// ---- The builder self-validation net ----

test("builder self-validation: a misconstruction throws a descriptive Error at build time, not at submit", () => {
  // A malformed `to` stamps "0.5" (the interAgentEnvelope row) and then dies against the v0.5
  // grammar its own stamp selects: the first `#` must start a `sess_` segment.
  assert.throws(
    () => buildNotify({ agent: AGENT, title: "t", to: "agent:peer#bogus" }, clock),
    /builder self-check, stamped 0\.5/,
  );
  // A base-minor misconstruction dies against the v0.4 registry the "0.3" stamp selects.
  assert.throws(
    () => buildNotify({ agent: AGENT, title: "x".repeat(201) }, clock),
    /builder self-check, stamped 0\.3/,
  );
});

// ---- Known-key-set rebuild of request/action + post-build mutation isolation ----

test("widened caller objects cannot leak extra keys onto the wire: request/action are rebuilt from their known key sets", () => {
  const dirtyRequest = {
    ...MINIMAL_REQUEST,
    internal_note: "do not leak",
    api_token_ref: "env:SECRET",
  } as AskRequest;
  const ask = buildAsk(
    { agent: AGENT, title: "t", idempotency_key: newIdempotencyKey(), request: dirtyRequest },
    clock,
  );
  assert.equal("internal_note" in ask.request, false);
  assert.equal("api_token_ref" in ask.request, false);
  assert.deepEqual(ask.request, MINIMAL_REQUEST, "exactly the known keys survive");

  const dirtyAction = {
    instructions: "rotate the key",
    internal_note: "do not leak",
    api_token_ref: "env:SECRET",
  } as TaskAction;
  const task = buildTask(
    { agent: AGENT, title: "t", idempotency_key: newIdempotencyKey(), action: dirtyAction },
    clock,
  );
  assert.equal("internal_note" in task.action, false);
  assert.equal("api_token_ref" in task.action, false);
  assert.deepEqual(task.action, { instructions: "rotate the key" });
});

test("post-build mutation of caller-owned objects does not alter the built envelope (stable under a minted idempotency_key)", () => {
  const state = { sealed: "blob-1" };
  const tags = ["deploy"];
  const request: AskRequest = { mode: "select", options: [{ value: "ok", label: "OK" }] };
  const ask = buildAsk(
    { agent: AGENT, title: "t", idempotency_key: newIdempotencyKey(), state, tags, request },
    clock,
  );
  state["sealed"] = "attacker";
  tags.push("late");
  request.mode = "input";
  request.options?.push({ value: "evil", label: "Evil" });
  assert.deepEqual(ask.state, { sealed: "blob-1" });
  assert.deepEqual(ask.tags, ["deploy"]);
  assert.equal(ask.request.mode, "select");
  assert.deepEqual(ask.request.options, [{ value: "ok", label: "OK" }]);

  const checklist = [{ text: "open console" }];
  const task = buildTask(
    { agent: AGENT, title: "t", idempotency_key: newIdempotencyKey(), action: { instructions: "x", checklist } },
    clock,
  );
  checklist[0]!.text = "changed";
  checklist.push({ text: "late step" });
  assert.deepEqual(task.action.checklist, [{ text: "open console" }]);
});

// ---- Non-object error guards, the reverse misroute, null Response, type-vs-kind ----

test("effectiveCode and classifyHubError guard non-object errors: null/undefined/primitive read as code-less, never TypeError", () => {
  for (const e of [null, undefined, "gone", 410]) {
    assert.equal(effectiveCode(e, "presentation"), undefined, JSON.stringify(e));
  }
  assert.deepEqual(classifyHubError(undefined, "presentation"), { class: "unreadable" });
  assert.deepEqual(classifyHubError(410, "presentation"), { class: "unreadable" });
});

test("reverse misroute: a non-addressed submit acked with a destination snapshot or an addressed-only status fails structurally", () => {
  const withSnapshot = validateSubmitAck(
    { id: "msg_09", status: "open", poll_url: POLL_URL, destination: { state: "unknown" } },
    { addressed: false },
  );
  assert.equal(withSnapshot.valid, false);
  if (withSnapshot.valid) assert.fail("expected invalid");
  assert.equal(withSnapshot.misroute, false, "misroute stays reserved for the addressed-path failure");
  assert.ok(withSnapshot.errors.some((e) => e.includes("destination snapshot")), JSON.stringify(withSnapshot.errors));

  for (const status of ["queued", "bounced", "acknowledged"]) {
    const result = validateSubmitAck({ id: "msg_10", status, poll_url: POLL_URL }, { addressed: false });
    assert.equal(result.valid, false, status);
    if (result.valid) assert.fail("expected invalid");
    assert.equal(result.misroute, false);
    assert.ok(result.errors.some((e) => e.includes("addressed-only status")), JSON.stringify(result.errors));
  }
  // The SAME snapshot-carrying ack on an ADDRESSED submit stays valid — context is the detector.
  assert.equal(
    validateSubmitAck(
      { id: "msg_09", status: "open", poll_url: POLL_URL, destination: { state: "unknown" } },
      { addressed: true },
    ).valid,
    true,
  );
});

test("terminal-requires-Response treats JSON null as missing (§8.2)", () => {
  const result = validatePollStatus(
    { id: "msg_01", status: "answered", response: null },
    { id: "msg_01", type: "ask", addressed: false },
  );
  assert.equal(result.valid, false);
  if (result.valid) assert.fail("expected invalid");
  assert.ok(result.errors.some((e) => e.includes("requires the embedded response")), JSON.stringify(result.errors));
});

test("validateKnownFields cross-checks a declared `type` against the checked message kind", () => {
  // The fixture is an ask: checked as `task` it must refuse on the declaration itself, not pass
  // under the wrong keep-list.
  const mismatched = validateKnownFields(MESSAGE_FIXTURE, "task");
  assert.equal(mismatched.valid, false);
  if (mismatched.valid) assert.fail("expected invalid");
  assert.ok(mismatched.errors.some((e) => e.includes('declares type "ask"')), JSON.stringify(mismatched.errors));
  // The matching kind still passes, and the directive kind performs no message cross-check.
  assert.deepEqual(validateKnownFields(MESSAGE_FIXTURE, "ask"), { valid: true });
  assert.deepEqual(validateKnownFields(DIRECTIVE_FIXTURE, "directive"), { valid: true });
});

// ---- Frozen-table pins and the JSON-parsed own-__proto__ entry ----

test("every exported table is frozen — a runtime mutation cannot widen a status/keep/content/signed list", () => {
  const tables: Record<string, object> = {
    ASK_STATUSES,
    TASK_STATUSES,
    HUMAN_INBOX_NOTIFY_STATUSES,
    ADDRESSED_NOTIFY_STATUSES,
    TERMINAL_ASK_TASK_STATUSES,
    ENTRY_KINDS,
    DIRECTIVE_KEEP_FIELDS,
    MESSAGE_ENTRY_KEEP_FIELDS,
    "MESSAGE_ENTRY_KEEP_FIELDS.notify": MESSAGE_ENTRY_KEEP_FIELDS.notify,
    "MESSAGE_ENTRY_KEEP_FIELDS.ask": MESSAGE_ENTRY_KEEP_FIELDS.ask,
    "MESSAGE_ENTRY_KEEP_FIELDS.task": MESSAGE_ENTRY_KEEP_FIELDS.task,
    WIRE_FEATURES,
    "WIRE_FEATURES.interAgentEnvelope": WIRE_FEATURES.interAgentEnvelope,
    "WIRE_FEATURES.sessionQualifiedResolvers": WIRE_FEATURES.sessionQualifiedResolvers,
    SIGNED_FIELDS,
    SIGNED_INBOUND_FIELDS,
    DIRECTIVE_CONTENT_FIELDS,
    MESSAGE_ENTRY_CONTENT_FIELDS,
    "MESSAGE_ENTRY_CONTENT_FIELDS.notify": MESSAGE_ENTRY_CONTENT_FIELDS.notify,
    "MESSAGE_ENTRY_CONTENT_FIELDS.ask": MESSAGE_ENTRY_CONTENT_FIELDS.ask,
    "MESSAGE_ENTRY_CONTENT_FIELDS.task": MESSAGE_ENTRY_CONTENT_FIELDS.task,
    SIGNED_MESSAGE_ENTRY_FIELDS,
    SIGNED_RESPONSE_ENTRY_FIELDS,
    SIGNED_RECEIPT_FIELDS,
  };
  for (const [name, table] of Object.entries(tables)) {
    assert.equal(Object.isFrozen(table), true, `${name} must be frozen`);
  }
});

test("a JSON-parsed entry with an OWN __proto__ key is refused by validateKnownFields", () => {
  // JSON.parse mints `__proto__` as an ordinary own property (no setter runs) — the refusing
  // contract must see it as the unknown field it is, whatever enumeration primitive is in use.
  const entry = JSON.parse('{"title":"t","__proto__":{"polluted":true}}') as object;
  assert.ok(Object.getOwnPropertyNames(entry).includes("__proto__"), "own property, not a prototype swap");
  const result = validateKnownFields(entry, "directive");
  assert.equal(result.valid, false);
  if (result.valid) assert.fail("expected invalid");
  assert.ok(result.errors.some((e) => e.includes('"__proto__"')), JSON.stringify(result.errors));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, "no pollution escaped");
});

// ---- Keep-lists ⊇ schema-required fields (the derivation guard, R10 side) ----

const MESSAGE_SCHEMA = JSON.parse(
  readFileSync(new URL("../../schema/v0.5/message.schema.json", import.meta.url), "utf8"),
) as {
  required: string[];
  oneOf: { properties: { type: { const: string } }; required?: string[] }[];
};
const INBOUND_SCHEMA = JSON.parse(
  readFileSync(new URL("../../schema/v0.5/inbound-message.schema.json", import.meta.url), "utf8"),
) as { $defs: Record<string, { required?: string[]; allOf?: { required?: string[] }[] }> };

test("derivation guard: each keep-list covers every schema-required field of its kind", () => {
  // The directive keep-list ⊇ the delivered directive shape's required fields.
  const directiveRequired = INBOUND_SCHEMA.$defs["directive"]?.required;
  assert.ok(directiveRequired !== undefined && directiveRequired.length > 0);
  for (const field of directiveRequired) {
    assert.ok((DIRECTIVE_KEEP_FIELDS as readonly string[]).includes(field), `directive keep-list covers ${field}`);
  }
  // Each message-entry keep-list ⊇ the submit schema's root+branch required fields PLUS the
  // delivered-entry additions (id/from/to from the interAgentMessage wrapper).
  const entryExtra = (INBOUND_SCHEMA.$defs["interAgentMessage"]?.allOf ?? []).flatMap((b) => b.required ?? []);
  for (const field of ["id", "from", "to"]) assert.ok(entryExtra.includes(field), `wrapper requires ${field}`);
  for (const kind of ["notify", "ask", "task"] as const) {
    const branch = MESSAGE_SCHEMA.oneOf.find((b) => b.properties.type.const === kind);
    assert.ok(branch !== undefined, `oneOf branch for ${kind}`);
    const required = [...MESSAGE_SCHEMA.required, ...(branch.required ?? []), ...entryExtra];
    for (const field of required) {
      assert.ok(
        (MESSAGE_ENTRY_KEEP_FIELDS[kind] as readonly string[]).includes(field),
        `${kind} keep-list covers ${field}`,
      );
    }
  }
});

// ---- classifyHubError's compile-level exhaustiveness pin (the EntryVerdict mirror) ----

/** The consumption contract, positively: an EXHAUSTIVE switch narrows the reading to `never`. */
function exhaustiveReadingSwitchCompiles(reading: HubErrorReading): string {
  switch (reading.class) {
    case "auth":
      return reading.code;
    case "operator-close":
      return reading.code;
    case "own-terminal":
      return reading.code;
    case "lost-cas-race":
      return reading.code;
    case "propagate":
      return reading.code ?? "propagate";
    case "unreadable":
      return "unreadable";
    default: {
      const unhandled: never = reading;
      throw unhandled;
    }
  }
}

/**
 * The misuse the union exists to reject: a switch MISSING `operator-close` cannot satisfy the
 * never-assertion — folding the §16.4 kill-switch into a handling default is exactly the
 * re-register-through-the-kill drift. The @ts-expect-error is LOAD-BEARING: if the union ever
 * loosens so a non-exhaustive switch narrows to `never` anyway, the directive turns unused and
 * `tsc --noEmit` fails the build.
 */
function nonExhaustiveReadingSwitchIsRejected(reading: HubErrorReading): string {
  switch (reading.class) {
    case "auth":
      return reading.code;
    case "own-terminal":
      return reading.code;
    case "lost-cas-race":
      return reading.code;
    case "propagate":
      return reading.code ?? "propagate";
    case "unreadable":
      return "unreadable";
    default: {
      // @ts-expect-error — `reading` is NOT `never` here: the `operator-close` case is unhandled.
      const unhandled: never = reading;
      return (unhandled as { code: string }).code;
    }
  }
}

test("type-level: HubErrorReading forces exhaustive handling (the never-assertion contract)", () => {
  // The real assertions are compile-time; these runtime calls only keep the fixtures live.
  assert.equal(exhaustiveReadingSwitchCompiles({ class: "unreadable" }), "unreadable");
  assert.equal(
    nonExhaustiveReadingSwitchIsRejected({ class: "operator-close", code: "session_closed_by_operator" }),
    "session_closed_by_operator",
  );
});

// ---- The notify and task digest branches (the existing ask case's three-way style) ----

test("notify digest: function == exported-list recompute == hand-enumerated recompute (advisory fields excluded)", () => {
  const entry: InterAgentMessage = {
    ma2h_version: "0.5",
    type: "notify",
    id: "msg_n1",
    from: "agent:overseer/fleet#sess_o",
    to: "agent:worker",
    created_at: FIXED_NOW,
    agent: { id: "overseer/fleet", run_id: "run_n", runtime: "cli" },
    title: "fleet digest",
    body: "all green",
    priority: "low",
    tags: ["digest"],
    sensitive: true,
  };
  const byList = createHash("sha256")
    .update(canonicalize({ message: pickPresent(entry, MESSAGE_ENTRY_CONTENT_FIELDS.notify) }))
    .digest("hex");
  // Hand-enumerated: the notify branch's documented binding set, spelled out independently of
  // BOTH the exported list and the shared projection helper.
  const byHand = createHash("sha256")
    .update(
      canonicalize({
        message: {
          type: "notify",
          title: "fleet digest",
          body: "all green",
          priority: "low",
          tags: ["digest"],
          sensitive: true,
        },
      }),
    )
    .digest("hex");
  assert.equal(computeMessageEntryPayloadSha256(entry), byList);
  assert.equal(byList, byHand, "id/from/to/created_at/agent are excluded from the digest");
});

test("task digest: function == exported-list recompute == hand-enumerated recompute (idempotency_key stays inert)", () => {
  const entry: InterAgentMessage = {
    ma2h_version: "0.5",
    type: "task",
    id: "msg_t1",
    from: "agent:overseer/fleet",
    to: "agent:worker#sess_w",
    created_at: FIXED_NOW,
    agent: { id: "overseer/fleet", run_id: "run_t", runtime: "cli" },
    title: "rotate the key",
    idempotency_key: "idem_task_1",
    action: { instructions: "rotate", checklist: [{ text: "open console" }] },
  };
  const byList = createHash("sha256")
    .update(canonicalize({ message: pickPresent(entry, MESSAGE_ENTRY_CONTENT_FIELDS.task) }))
    .digest("hex");
  const byHand = createHash("sha256")
    .update(
      canonicalize({
        message: {
          type: "task",
          title: "rotate the key",
          action: { instructions: "rotate", checklist: [{ text: "open console" }] },
        },
      }),
    )
    .digest("hex");
  assert.equal(computeMessageEntryPayloadSha256(entry), byList);
  assert.equal(byList, byHand, "idempotency_key and the advisory agent descriptor are excluded");
});

// ---- Non-object body guards and the empty drain batch ----

test("non-object bodies refuse cleanly (never throw), and an empty drain batch is a valid zero-entry batch", () => {
  for (const body of [null, "x"]) {
    const ack = validateSubmitAck(body, { addressed: false });
    assert.equal(ack.valid, false, JSON.stringify(body));
    if (ack.valid) assert.fail("expected invalid");
    assert.equal(ack.misroute, false);
    assert.ok(ack.errors.some((e) => e.includes("JSON object")), JSON.stringify(ack.errors));
  }
  const poll = validatePollStatus(null, { id: "msg_01", type: "ask", addressed: false });
  assert.equal(poll.valid, false);
  if (poll.valid) assert.fail("expected invalid");
  assert.ok(poll.errors.some((e) => e.includes("JSON object")), JSON.stringify(poll.errors));

  const empty = validateDrainBatch([]);
  assert.equal(empty.valid, true);
  if (!empty.valid) assert.fail("expected valid");
  assert.equal(empty.entries.length, 0);
});
