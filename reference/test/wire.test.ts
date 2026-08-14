// U3 (issue #45): the wire.ts envelope builders and the canonical version-stamp rule.
//
// Every version assertion here is a STRING LITERAL on purpose — never `MA2H_VERSION`. The rule's
// arms are static properties of the envelope's features (the oh-hai#712 class), so the pins must
// not float with the implementation's current version: at the v0.6 bump these tests still demand
// "0.3"/"0.5" from the same inputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildAsk,
  buildNotify,
  buildTask,
  isAddressedEnvelope,
  newIdempotencyKey,
  wireVersionFor,
  WIRE_BASE_VERSION,
  WIRE_FEATURES,
  type AskInput,
  type TaskInput,
} from "../src/wire.js";
import { validateMessage, validateV05 } from "../src/envelope.js";
import type { AgentDescriptor, AskRequest } from "../src/types.js";

const AGENT: AgentDescriptor = { id: "wire-bot", run_id: "run_1", runtime: "cli" };
const FIXED_NOW = "2026-08-13T12:00:00.000Z";
const clock = (): Date => new Date(FIXED_NOW);
const MINIMAL_REQUEST: AskRequest = { mode: "select", options: [{ value: "ok", label: "OK" }] };

// ---- The version-stamp rule (both arms pinned by literal) ----

test("the rule's arms are the module's own literals: base \"0.3\", addressed minimum \"0.5\"", () => {
  assert.equal(WIRE_BASE_VERSION, "0.3");
  assert.equal(WIRE_FEATURES.addressed.minimum, "0.5");
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

test("isAddressedEnvelope: `to` present or `agent.session` present, nothing else", () => {
  assert.equal(isAddressedEnvelope({ agent: AGENT }), false);
  assert.equal(isAddressedEnvelope({ agent: AGENT, to: "agent:peer" }), true);
  assert.equal(isAddressedEnvelope({ agent: { ...AGENT, session: "sess_me" } }), true);
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
