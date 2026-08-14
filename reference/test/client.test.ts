// The §13.4 verdict taxonomy of the vendorable client layer (issue #45, R4): structured
// disposition codes minted at every refusal/acceptance site in `client.ts`, and the exported
// `classifyEntryResult` classifier the bridge loop now consumes. Reason STRINGS stay byte-identical
// presentation (three bridge.test.ts regexes and the classifier's documented fallback depend on
// them) — these tests assert the CODES, plus the fallback's explicit fatal-before-benign
// precedence and the discriminated union's compile-level exhaustiveness contract.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hub } from "../src/hub.js";
import {
  Agent,
  classifyEntryResult,
  sanitizeDirective,
  sanitizeMessageEntry,
  type EntryResult,
  type EntryVerdict,
} from "../src/client.js";
import { runBridgeLoop, type BridgeHub } from "../src/agent.js";
import { validateDrainBatch } from "../src/wire.js";
import type { AskMessage, InboundDirective, InboxEntryDelivery, InterAgentMessage } from "../src/types.js";

const KEY = "hub-client-key-0123456789abcdef0123456789abcdef";
const T0 = 1_786_752_000_000;
const SENDER = "overseer/fleet";
const OUTSIDER = "someone/else";
const WORKER = "deploybot/dev-team";
const OWNER = "human:you";

function newHub(now: { t: number }): Hub {
  const hub = new Hub({ signingKey: KEY, now: () => now.t, sessionMinTtlSeconds: 60 });
  hub.setAgentOwner(SENDER, OWNER);
  hub.setAgentOwner(OUTSIDER, OWNER);
  hub.setAgentOwner(WORKER, OWNER);
  hub.setInterAgentEnabled(OWNER); // §8.0: the inter-agent leg is account-opt-in (defaults off)
  return hub;
}

function newWorkerAgent(senderPolicy?: string[] | "any-same-account"): Agent {
  return new Agent({
    callbackUrl: "https://worker.example/resume",
    callbackKey: KEY,
    sealKey: randomBytes(32),
    agentId: `agent:${WORKER}`,
    ...(senderPolicy !== undefined ? { senderPolicy } : {}),
  });
}

function askFrom(sender: string, idempotencyKey: string): AskMessage {
  return {
    ma2h_version: "0.5",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: sender, run_id: "run_01", runtime: "cli" },
    to: `agent:${WORKER}` as `agent:${string}`,
    title: "May I restart your queue consumer?",
    idempotency_key: idempotencyKey,
    request: { mode: "confirm" },
  };
}

type MessageDelivery = Extract<InboxEntryDelivery, { message: unknown }>;

/** Drain the worker's mailbox presenting `session` and return its single message-entry delivery. */
function drainOneMessage(hub: Hub, session: string, nowMs: number): MessageDelivery {
  const entries = hub.drainInbox(WORKER, { session, now: nowMs });
  assert.equal(entries.length, 1, "expected exactly one pending entry");
  const entry = entries[0] as InboxEntryDelivery;
  assert.ok("message" in entry, "expected a message entry");
  return entry;
}

/** A worker agent with a registered live session, plus one pending ask from SENDER. */
function workerWithPendingAsk(
  now: { t: number },
  senderPolicy?: string[] | "any-same-account",
): { hub: Hub; agent: Agent; session: string } {
  const hub = newHub(now);
  hub.submit(askFrom(SENDER, "restart-consumer-1"));
  const session = hub.registerSession(WORKER, undefined, now.t).session.id;
  const agent = newWorkerAgent(senderPolicy);
  agent.setSession(session);
  return { hub, agent, session };
}

// ---- Each disposition, minted as a structured code at its refusal/acceptance site (R4) ----

test("a signature refusal mints `fatal-verification` — asserted on the structured code, not the string", () => {
  const now = { t: T0 };
  const { agent, hub, session } = workerWithPendingAsk(now, [SENDER]);
  const entry = drainOneMessage(hub, session, now.t);
  const res = agent.receiveMessageEntry(entry.message, "garbage, not a signature header", now.t);
  assert.ok(!res.acted);
  assert.equal(res.disposition, "fatal-verification");
  const verdict = classifyEntryResult({ kind: "message", result: res });
  assert.equal(verdict.disposition, "fatal-verification");
  // The reason stays byte-stable presentation (the classifier's own fallback parses this prefix).
  assert.ok(verdict.disposition === "fatal-verification" && verdict.reason.startsWith("signature: "));
  assert.equal(verdict.reason, res.reason, "the classifier passes the reason through verbatim");
});

test("an accepted entry mints `accepted`; its post-commit redelivery mints `benign-redelivery` (§13.4 dedup)", () => {
  const now = { t: T0 };
  const { agent, hub, session } = workerWithPendingAsk(now, [SENDER]);

  const first = drainOneMessage(hub, session, now.t);
  const accepted = agent.receiveMessageEntry(first.message, first.signature, now.t);
  assert.ok(accepted.acted);
  assert.equal(accepted.disposition, "accepted");
  assert.equal(classifyEntryResult({ kind: "message", result: accepted }).disposition, "accepted");
  accepted.commit(); // durably processed: promote the in-flight reservation to the permanent dedup

  // Never acked, so past the visibility window the Hub redelivers, re-signed with a FRESH jti
  // (§8.7) — the committed id dedup, not the replay cache, is what refuses it.
  now.t += 61_000;
  const redelivery = drainOneMessage(hub, session, now.t);
  const res = agent.receiveMessageEntry(redelivery.message, redelivery.signature, now.t);
  assert.ok(!res.acted);
  assert.equal(res.disposition, "benign-redelivery");
  assert.equal(res.reason, "duplicate delivery (already acted)"); // presentation, byte-identical
  assert.equal(classifyEntryResult({ kind: "message", result: res }).disposition, "benign-redelivery");
});

test("a sender-policy refusal mints `refused` — verified but never acted on, left to redelivery (§13.4)", () => {
  // No declared policy: the §13.4 MUST has no implicit default.
  const now = { t: T0 };
  const { agent, hub, session } = workerWithPendingAsk(now); // no senderPolicy
  const entry = drainOneMessage(hub, session, now.t);
  const res = agent.receiveMessageEntry(entry.message, entry.signature, now.t);
  assert.ok(!res.acted);
  assert.equal(res.disposition, "refused");
  assert.match(res.reason, /no declared sender policy/);
  assert.equal(classifyEntryResult({ kind: "message", result: res }).disposition, "refused");

  // A sender OUTSIDE the declared policy refuses the same way.
  const now2 = { t: T0 };
  const { agent: strict, hub: hub2, session: session2 } = workerWithPendingAsk(now2, [OUTSIDER]);
  const entry2 = drainOneMessage(hub2, session2, now2.t);
  const res2 = strict.receiveMessageEntry(entry2.message, entry2.signature, now2.t);
  assert.ok(!res2.acted);
  assert.equal(res2.disposition, "refused");
  assert.match(res2.reason, /not in the declared policy/);
});

test("an in-flight duplicate mints `refused`, never benign — the overlapping first delivery has not committed", () => {
  const now = { t: T0 };
  const { agent, hub, session } = workerWithPendingAsk(now, [SENDER]);
  const first = drainOneMessage(hub, session, now.t);
  const accepted = agent.receiveMessageEntry(first.message, first.signature, now.t);
  assert.ok(accepted.acted); // reserved in-flight — deliberately NOT committed

  // The un-acked entry redelivers (fresh jti) while the first delivery is still being processed:
  // the concurrency nuance — nothing is durably done yet, so acking the overlap as benign would
  // discard the redelivery a crashed first attempt needs to retry. Frozen behavior: `refused`.
  now.t += 61_000;
  const overlap = drainOneMessage(hub, session, now.t);
  const res = agent.receiveMessageEntry(overlap.message, overlap.signature, now.t);
  assert.ok(!res.acted);
  assert.equal(res.disposition, "refused");
  assert.equal(res.reason, "duplicate delivery (in flight)"); // presentation, byte-identical
  assert.equal(classifyEntryResult({ kind: "message", result: res }).disposition, "refused");
});

// ---- Precedence: replay is fatal, never benign (R4's pinned check order) ----

test("precedence: a replay refusal classifies `fatal-verification`, never benign — minted AND via the fallback", () => {
  // Minted: the same signed bytes presented twice — the jti replay cache refuses the second.
  const now = { t: T0 };
  const { agent, hub, session } = workerWithPendingAsk(now, [SENDER]);
  const entry = drainOneMessage(hub, session, now.t);
  const accepted = agent.receiveMessageEntry(entry.message, entry.signature, now.t);
  assert.ok(accepted.acted);
  accepted.commit();
  const replayed = agent.receiveMessageEntry(entry.message, entry.signature, now.t);
  assert.ok(!replayed.acted);
  assert.equal(replayed.reason, "replay: jti already seen"); // contains the benign "already seen" substring…
  assert.equal(replayed.disposition, "fatal-verification"); // …but the minted code is structural: fatal
  assert.equal(classifyEntryResult({ kind: "message", result: replayed }).disposition, "fatal-verification");

  // Fallback (a result minted without a code): ONLY the explicit fatal-before-benign check order
  // keeps `"replay: jti already seen"` out of the benign class — pinned here.
  const unminted: EntryResult = { kind: "message", result: { acted: false, reason: "replay: jti already seen" } };
  assert.equal(classifyEntryResult(unminted).disposition, "fatal-verification");
});

// ---- The documented string fallback, and the code's authority over presentation ----

test("the string fallback classifies unminted results; reasons pass through verbatim", () => {
  const unminted = (reason: string): EntryResult => ({ kind: "directive", result: { acted: false, reason } });
  for (const reason of ["signature: bad MAC", "invalid directive: missing title", "replay: jti already seen"]) {
    const v = classifyEntryResult(unminted(reason));
    assert.equal(v.disposition, "fatal-verification");
    assert.ok(v.disposition === "fatal-verification" && v.reason === reason);
  }
  for (const reason of ["duplicate delivery (already acted)", "duplicate receipt (already seen)"]) {
    assert.equal(classifyEntryResult(unminted(reason)).disposition, "benign-redelivery");
  }
  for (const reason of [
    "addressee mismatch: directive.to agent:x != agent:y",
    "no declared sender policy — refusing to act on an addressed ask/task (§13.4)",
    "duplicate delivery (in flight)", // the concurrency artifact stays refused, never benign
  ]) {
    assert.equal(classifyEntryResult(unminted(reason)).disposition, "refused");
  }
  // An unminted ACCEPTED result classifies accepted — the disposition field is additive, not required.
  const acceptedNoCode: EntryResult = { kind: "response", result: { acted: true, resolution: "answered", state: null } };
  assert.equal(classifyEntryResult(acceptedNoCode).disposition, "accepted");
});

test("the structured code is authoritative: a minted disposition wins over contradictory reason text", () => {
  // Reasons are PRESENTATION — they interpolate raw Error messages, so one could grow a fatal-
  // looking prefix. The classifier must key on the code and never re-parse a minted result.
  const coded: EntryResult = {
    kind: "response",
    result: { acted: false, disposition: "refused", reason: "signature: interpolated presentation text" },
  };
  assert.equal(classifyEntryResult(coded).disposition, "refused");
});

// ---- Classifier-vs-loop consistency (the loop's observable behavior is byte-frozen) ----

/** The real Hub's bridge surface, spreadable into failure-injecting stubs (as bridge.test.ts). */
function bridgeSurface(hub: Hub): BridgeHub {
  return {
    registerSession: (p, r, n) => hub.registerSession(p, r, n),
    drainInbox: (p, o) => hub.drainInbox(p, o),
    ackInbox: (p, ids, o) => hub.ackInbox(p, ids, o),
    closeSession: (s, c, n) => hub.closeSession(s, c, n),
    resolveAsAgent: (id, p, b, o) => hub.resolveAsAgent(id, p, b, o),
  };
}

test("classifier-vs-loop consistency: a mixed stubbed-Hub run keeps the pre-classifier report counters", () => {
  // Mirrors bridge.test.ts's happy-path and policy-refusal fixtures, mixed into ONE run: an
  // in-policy ask (accepted + resolved), an out-of-policy ask (refused on BOTH deliveries — it
  // redelivers), and — with every ack dropped by the stub — the accepted entry's own redelivery
  // (benign: acked without re-acting). The counters below are exactly what the pre-classifier
  // string-prefix loop produced for this mix.
  const now = { t: T0 };
  const hub = newHub(now);
  const { id: acceptedId } = hub.submit(askFrom(SENDER, "k-accept"));
  hub.submit(askFrom(OUTSIDER, "k-refuse"));
  const droppingAcks: BridgeHub = {
    ...bridgeSurface(hub),
    drainInbox: (p, o) => {
      const out = hub.drainInbox(p, o);
      now.t += 61_000; // the visibility window lapses between holds: un-acked mail redelivers
      return out;
    },
    ackInbox: () => ({ acked: 0 }), // drop every ack — the committed entry comes back as a redelivery
  };
  const report = runBridgeLoop(droppingAcks, {
    principal: WORKER,
    agent: newWorkerAgent([SENDER]),
    decide: () => ({ resolution: "answered", value: "approve" }),
    maxDrains: 2,
    now: () => now.t,
  });
  assert.equal(report.processed.messages, 1, "acted once — the benign redelivery never re-acts");
  assert.equal(report.processed.directives + report.processed.responses + report.processed.receipts, 0);
  assert.equal(report.refused.length, 2, "the out-of-policy ask, refused on both deliveries");
  for (const reason of report.refused) assert.match(reason, /not in the declared policy/);
  assert.equal(report.closed, true);
  assert.equal(hub.get(acceptedId, SENDER)?.status, "answered", "resolved exactly once");
});

// ---- The exhaustiveness contract, checked at COMPILE time (R4) ----

/**
 * The consumption contract, positively: an EXHAUSTIVE switch narrows the verdict to `never`, so
 * the never-assertion in the default branch compiles. Adding a fifth disposition to `EntryVerdict`
 * makes that assignment fail typecheck — every consumer is forced to handle the new disposition
 * instead of routing it through whatever its default happened to do.
 */
function exhaustiveSwitchCompiles(v: EntryVerdict): string {
  switch (v.disposition) {
    case "fatal-verification":
      return v.reason;
    case "benign-redelivery":
      return v.reason;
    case "refused":
      return v.reason;
    case "accepted":
      return "acted";
    default: {
      const unhandled: never = v;
      throw unhandled;
    }
  }
}

/**
 * The misuse the union exists to reject: a switch MISSING `fatal-verification` cannot satisfy the
 * never-assertion, because `v` is still the fatal branch inside `default` — folding it into a
 * handling default would silently continue after a signature failure. The @ts-expect-error below
 * is LOAD-BEARING: if the union ever loosens so a non-exhaustive switch narrows to `never` anyway
 * (the contract broke), the directive turns unused and `tsc --noEmit` fails the build.
 */
function nonExhaustiveSwitchIsRejected(v: EntryVerdict): string {
  switch (v.disposition) {
    case "benign-redelivery":
      return v.reason;
    case "refused":
      return v.reason;
    case "accepted":
      return "acted";
    default: {
      // @ts-expect-error — `v` is NOT `never` here: the `fatal-verification` case is unhandled.
      const unhandled: never = v;
      return (unhandled as { reason: string }).reason;
    }
  }
}

test("type-level: the verdict union forces exhaustive handling (the never-assertion contract)", () => {
  // The real assertions above are compile-time; these runtime calls only keep the fixtures live.
  assert.equal(exhaustiveSwitchCompiles({ disposition: "accepted" }), "acted");
  assert.equal(
    nonExhaustiveSwitchIsRejected({ disposition: "fatal-verification", reason: "signature: tampered" }),
    "signature: tampered",
  );
});

// ==== Review-fix batch (issue #45): dispatcher/classifier hardening ====

test("undefined-valued kind keys: validateDrainBatch and receiveEntry agree — dispatched by defined payload, never a throw-through", () => {
  const now = { t: T0 };
  const { agent, hub, session } = workerWithPendingAsk(now, [SENDER]);
  const entry = drainOneMessage(hub, session, now.t);

  // A hand-built row JSON.parse can never produce: an undefined-VALUED `directive` key beside a
  // real message payload. Both the batch guard and the dispatcher key on DEFINED payloads, so
  // they agree: the row passes the guard and reaches the MESSAGE handler (never
  // `receiveDirective(undefined)` and a TypeError outside the exit-code discipline).
  const crafted = {
    directive: undefined,
    message: entry.message,
    signature: entry.signature,
  } as unknown as InboxEntryDelivery;
  const batch = validateDrainBatch([crafted]);
  assert.equal(batch.valid, true, "the guard keys on defined payloads, not key presence");
  let outcome: EntryResult | undefined;
  assert.doesNotThrow(() => {
    outcome = agent.receiveEntry(crafted, now.t);
  });
  assert.equal(outcome?.kind, "message");
  assert.equal(outcome?.result.acted, true, "the real payload verified and was accepted");

  // A row with NO defined kind: refused by the batch guard, and dispatch alone still cannot
  // throw — it falls through to the receipt handler's shape refusal (a structured fatal result).
  const kindless = { signature: entry.signature } as unknown as InboxEntryDelivery;
  assert.equal(validateDrainBatch([kindless]).valid, false);
  let fallthrough: EntryResult | undefined;
  assert.doesNotThrow(() => {
    fallthrough = agent.receiveEntry(kindless, now.t);
  });
  assert.equal(fallthrough?.kind, "receipt");
  assert.equal(fallthrough?.result.acted, false);
  assert.equal(classifyEntryResult(fallthrough as EntryResult).disposition, "fatal-verification");
});

test("a contradictory mint — acted:false with disposition \"accepted\" — never classifies accepted", () => {
  // A structurally-widened third-party mint: the code contradicts the acted flag. Classifying it
  // `accepted` would ack an entry nothing acted on; it must fall to the string fallback instead.
  const benignText = {
    kind: "message",
    result: { acted: false, disposition: "accepted", reason: "duplicate delivery (already acted)" },
  } as unknown as EntryResult;
  assert.equal(classifyEntryResult(benignText).disposition, "benign-redelivery", "fallback reads the reason");
  const opaqueText = {
    kind: "message",
    result: { acted: false, disposition: "accepted", reason: "some opaque presentation text" },
  } as unknown as EntryResult;
  const verdict = classifyEntryResult(opaqueText);
  assert.equal(verdict.disposition, "refused", "worst case refused — never acked");
  assert.notEqual(classifyEntryResult(benignText).disposition, "accepted");
  assert.notEqual(verdict.disposition, "accepted" as typeof verdict.disposition);
});

test("code beats text: a benign-minted result with a fatal-LOOKING reason stays benign", () => {
  const coded: EntryResult = {
    kind: "message",
    result: { acted: false, disposition: "benign-redelivery", reason: "signature: interpolated presentation text" },
  };
  assert.equal(classifyEntryResult(coded).disposition, "benign-redelivery");
});

test("sanitizers strip a JSON-parsed OWN __proto__ key (§10/§13.4 — pinned against enumeration refactors)", () => {
  // JSON.parse mints `__proto__` as an ordinary own property (no setter runs); the keep-list
  // projection must drop it like any other unknown field, whatever enumeration primitive is used.
  const rawMessage = JSON.parse(
    '{"ma2h_version":"0.5","type":"notify","id":"msg_p1","from":"agent:overseer/fleet","to":"agent:worker",' +
      '"created_at":"2026-08-13T12:00:00.000Z","agent":{"id":"overseer/fleet","run_id":"r","runtime":"cli"},' +
      '"title":"t","__proto__":{"polluted":true}}',
  ) as InterAgentMessage;
  assert.ok(Object.getOwnPropertyNames(rawMessage).includes("__proto__"), "own property, not a prototype swap");
  const cleanMessage = sanitizeMessageEntry(rawMessage);
  assert.equal(Object.getOwnPropertyNames(cleanMessage).includes("__proto__"), false);
  assert.equal(Object.getPrototypeOf(cleanMessage), Object.prototype);

  const rawDirective = JSON.parse(
    '{"ma2h_version":"0.4","type":"directive","id":"dir_p1","from":"human:you","to":"agent:worker",' +
      '"created_at":"2026-08-13T12:00:00.000Z","title":"t","__proto__":{"polluted":true}}',
  ) as InboundDirective;
  const cleanDirective = sanitizeDirective(rawDirective);
  assert.equal(Object.getOwnPropertyNames(cleanDirective).includes("__proto__"), false);
  assert.equal(Object.getPrototypeOf(cleanDirective), Object.prototype);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, "no pollution escaped");
});
