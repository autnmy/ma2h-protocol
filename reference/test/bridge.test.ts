// The v0.5 bridge-loop worked example (spec §8.7.1, §13.4, §16): register → bounded-hold
// drain/reconnect → verify (incl. the session-qualified addressee check) → declared-policy check →
// act (§8.8 resolve) → ack with ?session= → close — and the LOUD failure discipline: distinct
// nonzero exit codes for auth failure / own-terminal session (`gone` → re-register vs the §16.4
// operator kill-switch → stop) / signature failure, never a silent death.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hub, HubError } from "../src/hub.js";
import {
  Agent,
  BridgeExitError,
  EXIT_AUTH_FAILURE,
  EXIT_SESSION_CLOSED_BY_OPERATOR,
  EXIT_SESSION_TERMINAL,
  EXIT_SIGNATURE_FAILURE,
  runBridgeLoop,
  type BridgeHub,
} from "../src/agent.js";
import type { HubErrorStatus } from "../src/errors.js";
import type { AskMessage, InboxEntryDelivery } from "../src/types.js";

const KEY = "hub-bridge-key-0123456789abcdef0123456789abcdef";
const T0 = 1_786_752_000_000;
const SENDER = "overseer/fleet";
const WORKER = "deploybot/dev-team";
const OWNER = "human:you";

function newHub(now: { t: number }): Hub {
  const hub = new Hub({ signingKey: KEY, now: () => now.t, sessionMinTtlSeconds: 60 });
  hub.setAgentOwner(SENDER, OWNER);
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

function askTo(to: string, session?: string): AskMessage {
  return {
    ma2h_version: "0.5",
    type: "ask",
    created_at: new Date(T0).toISOString(),
    agent: { id: SENDER, run_id: "run_01", runtime: "cli", ...(session !== undefined ? { session } : {}) },
    to: to as `agent:${string}`,
    title: "May I restart your queue consumer?",
    idempotency_key: "restart-consumer-1",
    request: { mode: "confirm" },
  };
}

test("happy path: register → drain → verify → policy → resolve → ack(?session=) → close; the sender learns everything (§13.4/§8.8)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const senderSession = hub.registerSession(SENDER).session;
  const { id } = hub.submit(askTo(`agent:${WORKER}`, senderSession.id));

  const report = runBridgeLoop(hub, {
    principal: WORKER,
    agent: newWorkerAgent([SENDER]),
    decide: (m) => (m.type === "ask" ? { resolution: "answered", value: "approve", comment: "Restarting now." } : undefined),
    maxDrains: 2,
    now: () => now.t,
  });

  assert.match(report.session, /^sess_/);
  assert.equal(report.processed.messages, 1);
  assert.equal(report.refused.length, 0);
  assert.equal(report.closed, true);

  // The sender's authoritative view: answered by the worker's session-qualified actor, mailbox
  // track acknowledged (the bridge acked with ?session=), and the bridge's session closed cleanly.
  const got = hub.get(id, SENDER);
  assert.equal(got?.status, "answered");
  assert.equal(got?.response?.response?.value, "approve");
  assert.equal(got?.response?.response?.actor, `agent:${WORKER}#${report.session}`);
  assert.equal(got?.mailbox?.state, "acknowledged");
  assert.equal(hub.getSession(report.session, WORKER).session.state, "closed");

  // The Response also landed in the SENDER's live session as a response entry (§6).
  const entries = hub.drainInbox(SENDER, { session: senderSession.id });
  assert.ok(entries.some((e) => "response" in e), "return leg delivered to the submitting session");
});

test("exit code 2: an auth failure exits loudly and distinctly (§9.1)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const failing: BridgeHub = {
    ...bridgeSurface(hub),
    registerSession: () => {
      throw new HubError("unauthenticated", "bad credential");
    },
  };
  try {
    runBridgeLoop(failing, { principal: WORKER, agent: newWorkerAgent(), now: () => now.t });
    assert.fail("expected BridgeExitError");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_AUTH_FAILURE);
  }
});

test("exit code 3: a lease lapse or self-close mid-run exits re-register-and-continue, loudly and distinctly (§8.7.1's 410 gone/§16.3)", () => {
  // A lease lapse lands between the register and the drain: the very first drain then reads the
  // own-terminal 410 `gone` — the re-register class, NOT the operator kill (which is exit 5).
  const lapse = { t: T0 };
  const lapseHub = newHub(lapse);
  const lapsing: BridgeHub = {
    ...bridgeSurface(lapseHub),
    registerSession: (principal, req, nowMs) => {
      const out = lapseHub.registerSession(principal, { ...req, ttl_seconds: 60 }, nowMs);
      lapse.t += 61_000; // the lease lapses before the first drain
      return out;
    },
  };
  try {
    runBridgeLoop(lapsing, { principal: WORKER, agent: newWorkerAgent(), now: () => lapse.t });
    assert.fail("expected BridgeExitError");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_SESSION_TERMINAL);
  }

  // A SELF-close (the owning principal's own DELETE — e.g. a crashed sibling holding the same
  // credential cleaning up) reads the same plain `gone` on the next touchpoint: still exit 3.
  const self = { t: T0 };
  const selfHub = newHub(self);
  const selfClosing: BridgeHub = {
    ...bridgeSurface(selfHub),
    registerSession: (principal, req, nowMs) => {
      const out = selfHub.registerSession(principal, req, nowMs);
      selfHub.closeSession(out.session.id, principal, nowMs); // closed by the OWNING principal
      return out;
    },
  };
  try {
    runBridgeLoop(selfClosing, { principal: WORKER, agent: newWorkerAgent(), now: () => self.t });
    assert.fail("expected BridgeExitError");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_SESSION_TERMINAL);
  }
});

test("exit code 5: the operator kill-switch mid-run exits stop-do-not-restart — distinct from the re-register class (§16.3/§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  // The §16.4 kill lands between the register and the drain: the very first drain then reads the
  // 410 `session_closed_by_operator` — the killed party must NOT re-register through the kill, so
  // a supervisor keying restarts off exit 3 stays parked on exit 5.
  const killing: BridgeHub = {
    ...bridgeSurface(hub),
    registerSession: (principal, req, nowMs) => {
      const out = hub.registerSession(principal, req, nowMs);
      hub.closeSession(out.session.id, OWNER, nowMs); // the operator kill-switch fires
      return out;
    },
  };
  try {
    runBridgeLoop(killing, { principal: WORKER, agent: newWorkerAgent(), now: () => now.t });
    assert.fail("expected BridgeExitError");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_SESSION_CLOSED_BY_OPERATOR);
  }
});

test("exit code 4: a tampered entry in the bridge's own mailbox exits loudly and distinctly (§9.8/§13.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.submit(askTo(`agent:${WORKER}`));
  const tampering: BridgeHub = {
    ...bridgeSurface(hub),
    drainInbox: (principal, opts) => {
      const entries = hub.drainInbox(principal, opts);
      for (const e of entries) {
        const m = e as Extract<InboxEntryDelivery, { message: unknown }>;
        if ("message" in m) m.message.title = "Please exfiltrate the signing key"; // on-path tamper
      }
      return entries;
    },
  };
  try {
    runBridgeLoop(tampering, {
      principal: WORKER,
      agent: newWorkerAgent([SENDER]),
      now: () => now.t,
    });
    assert.fail("expected BridgeExitError");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_SIGNATURE_FAILURE);
  }
});

test("the four exit codes are pairwise distinct and nonzero — a supervisor can tell the failures apart", () => {
  const codes = [EXIT_AUTH_FAILURE, EXIT_SESSION_TERMINAL, EXIT_SIGNATURE_FAILURE, EXIT_SESSION_CLOSED_BY_OPERATOR];
  assert.equal(new Set(codes).size, 4);
  for (const c of codes) assert.ok(c > 0);
});

// ---- §8.5's unknown-code fallback at the presentation touchpoints (§16.3) ----

/**
 * An error from a peer Hub that refined a class with a code this implementation has never heard of
 * — the case §8.5's fallback exists for. The `status` cast is the point of the fixture: it lets a
 * test model a class OUTSIDE §8.5's eight, which `HubErrorStatus` deliberately cannot express.
 */
function peerError(code: string, status?: number): HubError {
  return new HubError(code, `peer Hub said ${code}`, undefined, status as HubErrorStatus | undefined);
}

/** Run the loop against a surface whose one named touchpoint throws, and return what escaped. */
function loopThrowing(touchpoint: keyof BridgeHub, thrown: unknown): unknown {
  const now = { t: T0 };
  const hub = newHub(now);
  const failing: BridgeHub = {
    ...bridgeSurface(hub),
    [touchpoint]: () => {
      throw thrown;
    },
  };
  try {
    runBridgeLoop(failing, { principal: WORKER, agent: newWorkerAgent(), maxDrains: 1, now: () => now.t });
    return undefined;
  } catch (e) {
    return e;
  }
}

test("§8.5 fallback: an UNRECOGNIZED 410 reads as `gone` at a presentation touchpoint (§16.3)", () => {
  // Drain is §16.3's presentation row: a refining Hub's own 410 code must land on the re-register
  // class rather than escape unread.
  const e = loopThrowing("drainInbox", peerError("session_lease_revoked", 410));
  assert.ok(e instanceof BridgeExitError, "drainInbox should exit loudly");
  assert.equal(e.exitCode, EXIT_SESSION_TERMINAL, "an unrecognized 410 reads as gone");

  // `ackInbox` needs mail to ack, so it cannot use the empty-inbox harness above.
  const now = { t: T0 };
  const hub = newHub(now);
  hub.submit(askTo(`agent:${WORKER}`));
  const ackFailing: BridgeHub = {
    ...bridgeSurface(hub),
    ackInbox: () => {
      throw peerError("session_lease_revoked", 410);
    },
  };
  try {
    runBridgeLoop(ackFailing, {
      principal: WORKER,
      agent: newWorkerAgent([SENDER]),
      maxDrains: 1,
      now: () => now.t,
    });
    assert.fail("expected BridgeExitError");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_SESSION_TERMINAL);
  }
});

test("§8.5 fallback: an UNRECOGNIZED 401 or 403 reads as the auth class, at any touchpoint", () => {
  // The credential classes are about the CALLER, not the session, so they read the same at a
  // session-lifecycle call as at a presentation one — narrowing the 410 reading below must not
  // collaterally drop these.
  for (const status of [401, 403]) {
    for (const touchpoint of ["registerSession", "drainInbox"] as const) {
      const e = loopThrowing(touchpoint, peerError("credential_needs_rotation", status));
      assert.ok(e instanceof BridgeExitError, `${touchpoint}/${status} should exit loudly`);
      assert.equal(e.exitCode, EXIT_AUTH_FAILURE);
    }
  }
});

test("register and close are NOT presentation touchpoints: an unrecognized 410 stays loud (§16.3)", () => {
  // §16.3's presentation row is drain / ack / resolve / stream connect. Registration has no session
  // to present and close is an idempotent terminal transition, so neither has an absent-refinement
  // `gone` reading. Reading a peer's own 410 there as `gone` would tell a supervisor "lease lapsed,
  // re-register" — walking it into a re-registration loop against whatever actually failed.
  for (const touchpoint of ["registerSession", "closeSession"] as const) {
    const e = loopThrowing(touchpoint, peerError("tenant_suspended", 410));
    assert.ok(e instanceof HubError, `${touchpoint} should propagate the HubError`);
    assert.ok(!(e instanceof BridgeExitError), `${touchpoint} must not read an unrecognized 410 as gone`);
  }

  // A RECOGNIZED `gone` still maps at those calls — the narrowing is to the fallback, not to the
  // vocabulary: a Hub that genuinely says `gone` is understood wherever it says it.
  const known = loopThrowing("registerSession", new HubError("gone", "session is gone"));
  assert.ok(known instanceof BridgeExitError);
  assert.equal(known.exitCode, EXIT_SESSION_TERMINAL);
});

test("an error with NO code stays loud — a missing code is malformed, not an additive refinement", () => {
  // §8.5's envelope requires `code`. A transport or adapter that drops it while keeping a 410 or
  // 401 status must not be read as a lapsed session or a bad credential: the real fault is the
  // broken response, and papering over it sends the supervisor chasing the wrong remedy.
  for (const status of [410, 401]) {
    const e = loopThrowing("drainInbox", Object.assign(new Error("malformed hub response"), { status }));
    assert.ok(!(e instanceof BridgeExitError), `a code-less ${status} must not map to an exit code`);
    assert.ok(e instanceof Error);
  }
});

test("the fallback is gated on UNRECOGNIZED, not on unmapped — a known code still propagates as itself", () => {
  // `not_found` (404) and `rate_limited` (429) are vocabulary the loop deliberately does not map.
  // Reading them through the base-code table would hand them exit semantics §8.5 never gives them,
  // so they must escape as the HubError they are.
  for (const code of ["not_found", "rate_limited"] as const) {
    const e = loopThrowing("drainInbox", new HubError(code, "known but unmapped"));
    assert.ok(e instanceof HubError, `${code} should propagate as a HubError`);
    assert.ok(!(e instanceof BridgeExitError), `${code} must not be mapped to an exit code`);
    assert.equal(e.code, code);
  }
});

test("an unclassable error stays loud — the honest boundary survives the fallback", () => {
  // No status at all: nothing to fall back WITHIN.
  const noStatus = loopThrowing("drainInbox", peerError("hub_specific_refinement"));
  assert.ok(noStatus instanceof HubError);
  assert.ok(!(noStatus instanceof BridgeExitError));

  // A class outside §8.5's eight: the spec defines no base code for it, so inventing a reading
  // would be worse than rethrowing.
  const oddClass = loopThrowing("drainInbox", peerError("hub_specific_refinement", 500));
  assert.ok(oddClass instanceof HubError);
  assert.ok(!(oddClass instanceof BridgeExitError));
});

test("the fallback never diverts a RECOGNIZED marker: the kill-switch still outranks the 410 class (§16.4)", () => {
  // Both are 410s. If `session_closed_by_operator` were resolved through the base-code table it
  // would become `gone` and exit 3 — telling a killed bridge to re-register straight through the
  // kill it was just dealt. The known-code path must win.
  const e = loopThrowing("drainInbox", new HubError("session_closed_by_operator", "killed"));
  assert.ok(e instanceof BridgeExitError);
  assert.equal(e.exitCode, EXIT_SESSION_CLOSED_BY_OPERATOR);
});

test("§8.5 at the resolve touchpoint: an unrecognized 409 is a lost CAS race, an unrecognized 410 is terminal", () => {
  // Losing the §7 race is normal — the loop acks and carries on. A refining Hub's own 409 code
  // must read the same way, or a conformant peer would crash a bridge the base code would not.
  const now = { t: T0 };
  const hub = newHub(now);
  hub.submit(askTo(`agent:${WORKER}`));
  const racing: BridgeHub = {
    ...bridgeSurface(hub),
    resolveAsAgent: () => {
      throw peerError("resolution_superseded", 409);
    },
  };
  const report = runBridgeLoop(racing, {
    principal: WORKER,
    agent: newWorkerAgent([SENDER]),
    decide: () => ({ resolution: "answered", value: "approve" }),
    maxDrains: 1,
    now: () => now.t,
  });
  assert.equal(report.closed, true, "a lost race resolves normally — no BridgeExitError");
  assert.equal(report.processed.messages, 1);

  // A 410 at the same touchpoint is the session going terminal underneath the resolve: still loud.
  const now2 = { t: T0 };
  const hub2 = newHub(now2);
  hub2.submit(askTo(`agent:${WORKER}`));
  const terminal: BridgeHub = {
    ...bridgeSurface(hub2),
    resolveAsAgent: () => {
      throw peerError("session_lease_revoked", 410);
    },
  };
  try {
    runBridgeLoop(terminal, {
      principal: WORKER,
      agent: newWorkerAgent([SENDER]),
      decide: () => ({ resolution: "answered", value: "approve" }),
      maxDrains: 1,
      now: () => now2.t,
    });
    assert.fail("expected BridgeExitError");
  } catch (e) {
    assert.ok(e instanceof BridgeExitError);
    assert.equal(e.exitCode, EXIT_SESSION_TERMINAL);
  }
});

test("no declared sender policy: the ask is refused (never acted on, never acked) and left to redelivery (§13.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(askTo(`agent:${WORKER}`));
  const report = runBridgeLoop(hub, {
    principal: WORKER,
    agent: newWorkerAgent(), // no senderPolicy — the MUST has no implicit default
    maxDrains: 1,
    now: () => now.t,
  });
  assert.equal(report.processed.messages, 0);
  assert.equal(report.refused.length, 1);
  assert.match(report.refused[0] as string, /no declared sender policy/);
  assert.equal(hub.get(id, SENDER)?.status, "open", "not resolved");
  assert.equal(hub.get(id, SENDER)?.mailbox?.state, "delivered", "seen but NOT acknowledged — no false consume");
});

test("a sender outside the declared policy is refused; a policy of any-same-account admits it (§13.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  hub.submit(askTo(`agent:${WORKER}`));
  const strict = runBridgeLoop(hub, {
    principal: WORKER,
    agent: newWorkerAgent(["someone/else"]),
    maxDrains: 1,
    now: () => now.t,
  });
  assert.equal(strict.processed.messages, 0);
  assert.match(strict.refused[0] as string, /not in the declared policy/);

  now.t = T0 + 61_000; // past the visibility window — the entry redelivers
  const open = runBridgeLoop(hub, {
    principal: WORKER,
    agent: newWorkerAgent("any-same-account"),
    decide: () => ({ resolution: "declined" }),
    maxDrains: 1,
    now: () => now.t,
  });
  assert.equal(open.processed.messages, 1, "the explicit any-same-account policy admits the sender");
});

test("the session-qualified addressee check refuses an entry for a PRIOR own session (§13.4 amendment)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const prior = hub.registerSession(WORKER).session; // the bridge's PREVIOUS invocation
  hub.submit(askTo(`agent:${WORKER}#${prior.id}`, undefined));
  const agent = newWorkerAgent([SENDER]);
  // Drain AS the prior session (still live) but hand the entries to an agent whose CURRENT session
  // is a different one — modeling a bridge that re-registered while old mail was in flight.
  const entries = hub.drainInbox(WORKER, { session: prior.id });
  assert.equal(entries.length, 1);
  agent.setSession("sess_current-run");
  const entry = entries[0] as Extract<InboxEntryDelivery, { message: unknown }>;
  const res = agent.receiveMessageEntry(entry.message, entry.signature, now.t);
  assert.equal(res.acted, false);
  assert.match(res.acted === false ? res.reason : "", /session mismatch/);
});

test("an operator kill landing after the final ack is an orderly exit by design — nothing left for the kill to stop (§16.3/§16.4)", () => {
  const now = { t: T0 };
  const hub = newHub(now);
  const { id } = hub.submit(askTo(`agent:${WORKER}`));
  // The §16.4 kill fires AFTER the loop's last ack but BEFORE its own step-4 close: all mail is
  // already drained and acked, so there is nothing for the kill to stop — the loop's close is an
  // idempotent re-close of the terminal session and the run resolves normally, never exit 5.
  const killingAfterAck: BridgeHub = {
    ...bridgeSurface(hub),
    ackInbox: (principal, ids, o) => {
      const out = hub.ackInbox(principal, ids, o);
      if (o?.session !== undefined) hub.closeSession(o.session, OWNER, o.now); // the kill-switch, post-ack
      return out;
    },
  };
  const report = runBridgeLoop(killingAfterAck, {
    principal: WORKER,
    agent: newWorkerAgent([SENDER]),
    decide: () => ({ resolution: "answered", value: "approve" }),
    maxDrains: 1,
    now: () => now.t,
  });
  assert.equal(report.closed, true, "resolved normally — no BridgeExitError");
  assert.equal(report.processed.messages, 1);
  assert.equal(report.refused.length, 0);
  // The kill genuinely landed as an operator close…
  assert.equal(hub.getSession(report.session, WORKER).session.closed_by_operator, true);
  // …but every entry was consumed first, so nothing bounced: the sender's view stays clean.
  assert.equal(hub.get(id, SENDER)?.status, "answered");
  assert.equal(hub.get(id, SENDER)?.mailbox?.state, "acknowledged");
});

/** The real Hub's bridge surface, spreadable into failure-injecting stubs. */
function bridgeSurface(hub: Hub): BridgeHub {
  return {
    registerSession: (p, r, n) => hub.registerSession(p, r, n),
    drainInbox: (p, o) => hub.drainInbox(p, o),
    ackInbox: (p, ids, o) => hub.ackInbox(p, ids, o),
    closeSession: (s, c, n) => hub.closeSession(s, c, n),
    resolveAsAgent: (id, p, b, o) => hub.resolveAsAgent(id, p, b, o),
  };
}
