// Reference agent (client) — spec §2.1, §6, §9.2/§9.3, and the v0.5 consuming bridge
// (§8.7.1 entry kinds, §9.8 verification, §13.4 duties incl. the v0.5 amendments, §16 sessions).
//
// Models the ephemeral resume flow: the agent seals state before submitting, then
// a (possibly new) process calls `onResume` when a signed Response arrives by push
// or pull. onResume verifies the signature, deduplicates, and opens the sealed
// state — treating everything on the return leg as untrusted until verified.
// `runBridgeLoop` is the v0.5 worked example: register → drain → verify → act →
// ack → close, exiting LOUD (distinct nonzero codes) on auth failure, an
// own-terminal session (`gone` → re-register vs the §16.4 operator kill-switch's
// `session_closed_by_operator` → stop), or a signature failure — never a silent death.
//
// The §13.4 duty machinery — the `Agent` class, its result types, the sanitizers, the parsers,
// the ack-key rule, and the `BridgeHub` transport seam — was factored VERBATIM into `client.ts`
// (the vendorable layer, issue #45) and is re-exported below under its existing names, so every
// existing import keeps resolving from this module. What stays here is per-IMPLEMENTATION policy,
// not protocol mechanics: the worked-example loop and its exit-code contract (oh-hai#719's
// exclusion — the wire marker, not the exit code, is the cross-implementation contract).

import { ackKeyOf } from "./client.js";
import type { Agent, BridgeHub } from "./client.js";
import {
  baseCodeForStatus,
  isKnownHubErrorCode,
  type HubTouchpoint,
  type KnownHubErrorCode,
} from "./errors.js";
import type { InboxEntryDelivery, InterAgentMessage, JsonObject } from "./types.js";

// The re-export seam (issue #45): every previously-public moved symbol keeps resolving from this
// module under its existing name — values and types split per `verbatimModuleSyntax`. `client.ts`
// holds the one definition; vendor from there.
export { Agent, parseSignatureHeader } from "./client.js";
export type {
  AgentOptions,
  BridgeHub,
  DirectiveResult,
  EntryResult,
  MessageEntryResult,
  ParsedSignature,
  ReceiptResult,
  ResumeResult,
} from "./client.js";

// ---- The v0.5 bridge loop — the worked example (spec §8.7.1, §13.4, §16) ----
//
// register session → bounded-hold drain (each iteration models one long-poll hold + the reconnect
// that renews the lease, §16.2) → verify per §13.4 incl. the session-qualified addressee check →
// declared-policy check → act (resolve an addressed ask/task via §8.8) → ack with `?session=` →
// close. Failure discipline: LOUD, NEVER SILENT — distinct nonzero exit codes for the FOUR fatal
// classes, so a supervisor can tell "fix credentials" from "lease lapsed, re-register" from
// "someone is tampering" from "the operator pulled the kill-switch — stop". The own-session 410
// reads two ways (§16.3): `gone` means expired or self-closed — a production bridge would
// typically RE-register and continue (the worked example exits with the distinct code so the
// operator sees the lease lapsed); `session_closed_by_operator` means the account's human killed
// this session (§16.4) — do NOT re-register or restart; stop and escalate to a human. One honest
// boundary, by design: the loop never inspects the session returned by its final step-4 close, so
// an operator kill landing AFTER the last drain is indistinguishable from an orderly exit — the
// mail is already drained and acked, and there is nothing left for the kill to stop.
// §8.5's unknown-code fallback (MUST) is implemented, not merely documented — and it is read PER
// TOUCHPOINT, because §8.5 resolves an unrecognized code to what THAT touchpoint would have
// returned. Drain / ack / resolve-`?session=` are §16.3's presentation row, so an unrecognized 410
// there reads as `gone` and exits EXIT_SESSION_TERMINAL. Register and close operate on the session
// as a resource and are NOT in that row, so a 410 gets no reading there at all and stays loud —
// misreading a peer's own 410 at register as a lapsed lease would walk a supervisor into a
// re-registration loop against whatever actually failed. The credential classes (401/403) read the
// same everywhere; they are about the caller, not the session.
// Three things deliberately do NOT fall back: a recognized code the loop does not map (`not_found`,
// `rate_limited`) propagates as itself, a code whose class is also unrecognizable rethrows, and an
// error carrying NO code at all rethrows — §8.5's envelope requires a code, so its absence is a
// malformed response, not an additive refinement. The honest loud boundary, narrowed to the cases
// that actually warrant a reading.

/** Auth failure: the credential was rejected or is not authorized (§9.1). */
export const EXIT_AUTH_FAILURE = 2;
/** Own-but-terminal session on drain/ack (§8.7.1's 410 `gone`): the lease lapsed or the session
 * was self-closed — re-register and continue (§16.3). */
export const EXIT_SESSION_TERMINAL = 3;
/** An entry in the OWN mailbox failed §9.7/§9.8 verification — possible tampering. */
export const EXIT_SIGNATURE_FAILURE = 4;
/** The operator kill-switch (§16.4): the account's human closed this session
 * (`session_closed_by_operator`) — stop; do NOT re-register or restart; escalate to a human.
 * Distinct from EXIT_SESSION_TERMINAL, whose remedy (re-register) is exactly what a kill must
 * never trigger. */
export const EXIT_SESSION_CLOSED_BY_OPERATOR = 5;

/** A fatal bridge failure, carrying the distinct nonzero process exit code (never 0). */
export class BridgeExitError extends Error {
  constructor(
    public readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeExitError";
  }
}

/** What the bridge should do with a verified, policy-passed `message` entry (the "act" step). */
export type BridgeDecide = (message: InterAgentMessage) => {
  resolution: "answered" | "declined" | "completed" | "dismissed";
  value?: string | JsonObject;
  comment?: string;
  checklist?: { text: string; done: boolean }[];
} | void;

export interface BridgeOptions {
  /** The bridge's own `agent.id` (its credential identity). */
  principal: string;
  /** The Agent instance that verifies (§9.7/§9.8) and dedups (§13.4). */
  agent: Agent;
  /** The act step for addressed ask/task entries; a void return acks without resolving. */
  decide?: BridgeDecide;
  /** Bounded number of drain holds (each models one long-poll + reconnect-renewal). Default 3. */
  maxDrains?: number;
  /** Session registration knobs (label/ttl), passed through to §16.1. */
  register?: { run_id?: string; label?: string; kind?: string; ttl_seconds?: number };
  now?: () => number;
}

export interface BridgeReport {
  /** The session this run registered (and closed, unless it exited early). */
  session: string;
  processed: { directives: number; messages: number; responses: number; receipts: number };
  /** Entries refused without acting (policy/addressee/dedup refusals) — left to redelivery. */
  refused: string[];
  closed: boolean;
}

/**
 * The code to READ this error as, applying §8.5's unknown-code fallback (MUST): a code this
 * implementation recognizes reads as itself; an UNRECOGNIZED code reads as the base code its
 * touchpoint would have returned absent the refinement. `undefined` when neither the code nor its
 * class is recognizable — the caller must then stay loud rather than invent a reading.
 *
 * The `isKnownHubErrorCode` gate is load-bearing and is NOT "is this code mapped below". A
 * recognized code the bridge deliberately does not map — `not_found`, `rate_limited` — must keep
 * propagating as itself; routing it through the base-code table would hand it exit semantics §8.5
 * never gives it. Only genuinely unrecognized codes fall back.
 */
function effectiveCode(e: unknown, touchpoint: HubTouchpoint): KnownHubErrorCode | undefined {
  const code = (e as { code?: unknown }).code;
  // §8.5's envelope REQUIRES `code`. A MISSING one is a malformed response or a broken adapter, not
  // an unrecognized refinement — the fallback does not apply, and the failure must stay loud. Fall
  // back on a code-less 410 and a supervisor re-registers against a broken transport forever;
  // fall back on a code-less 401 and it chases a credential that was never the problem.
  if (typeof code !== "string" || code === "") return undefined;
  if (isKnownHubErrorCode(code)) return code;
  return baseCodeForStatus((e as { status?: number }).status, touchpoint);
}

/**
 * Map a Hub error to the pinned exit codes; anything unmapped rethrows as itself (still loud).
 *
 * The caller passes its OWN touchpoint — §8.5's fallback reads an unrecognized code as what that
 * touchpoint would have returned, so the answer differs by call site. Drain / ack / resolve-
 * `?session=` are §16.3's presentation row; register and close operate on the session as a resource
 * and get no 410 reading at all (`session-lifecycle`), which is what keeps a peer's own 410 at
 * those calls from being misread as a lapsed lease.
 */
function mapHubError(e: unknown, touchpoint: HubTouchpoint): never {
  const code = effectiveCode(e, touchpoint);
  if (code === "unauthenticated" || code === "not_authorized" || code === "agent_id_mismatch") {
    throw new BridgeExitError(EXIT_AUTH_FAILURE, `auth failure: ${(e as Error).message}`);
  }
  // §8.5/§16.4: the operator kill-switch is matched BEFORE the generic terminal class — both are
  // 410s, and the marker's whole point is that the killed party stops instead of re-registering.
  if (code === "session_closed_by_operator") {
    throw new BridgeExitError(
      EXIT_SESSION_CLOSED_BY_OPERATOR,
      `session closed by the account's operator — stop, do not re-register: ${(e as Error).message}`,
    );
  }
  if (code === "gone") {
    throw new BridgeExitError(EXIT_SESSION_TERMINAL, `own session is terminal: ${(e as Error).message}`);
  }
  throw e;
}

/**
 * Run the bridge loop once, end to end. Throws `BridgeExitError` (with the distinct code) on the
 * four fatal classes; every other Hub error propagates unwrapped. Never returns "success" having
 * swallowed a failure.
 */
export function runBridgeLoop(hub: BridgeHub, opts: BridgeOptions): BridgeReport {
  const now = opts.now ?? ((): number => Date.now());
  const report: BridgeReport = {
    session: "",
    processed: { directives: 0, messages: 0, responses: 0, receipts: 0 },
    refused: [],
    closed: false,
  };

  // 1. Register this invocation's session (§16.1) — its address for the run.
  let sessionId: string;
  try {
    sessionId = hub.registerSession(opts.principal, opts.register, now()).session.id;
  } catch (e) {
    mapHubError(e, "session-lifecycle");
  }
  report.session = sessionId;
  opts.agent.setSession(sessionId);

  // 2. Bounded drain loop: each iteration is one long-poll hold; issuing the next drain is the
  //    reconnect that renews the lease (§16.2) — no heartbeat endpoint exists by design.
  const drains = opts.maxDrains ?? 3;
  for (let i = 0; i < drains; i++) {
    let entries: InboxEntryDelivery[];
    try {
      entries = hub.drainInbox(opts.principal, { session: sessionId, now: now() });
    } catch (e) {
      mapHubError(e, "presentation");
    }
    const toAck: string[] = [];
    for (const delivery of entries) {
      const outcome = opts.agent.receiveEntry(delivery, now());
      const r = outcome.result;
      if (!r.acted) {
        // §13.4 discipline: a failed VERIFICATION is fatal and loud — an entry in the bridge's own
        // mailbox that does not verify means tampering or a broken Hub, never something to skip
        // past. SHAPE validation (`invalid …`) is part of the same §8.7.1 verification step — a
        // malformed entry or one carrying unsigned forbidden fields is unverifiable Hub output, so
        // it is fatal too, not a skippable refusal. Dedup refusals are benign (the work already
        // happened durably): ack the redelivery.
        if (r.reason.startsWith("signature:") || r.reason.startsWith("replay:") || r.reason.startsWith("invalid ")) {
          throw new BridgeExitError(EXIT_SIGNATURE_FAILURE, `entry failed verification: ${r.reason}`);
        }
        if (r.reason.includes("already acted") || r.reason.includes("already seen")) {
          toAck.push(ackKeyOf(delivery)); // benign redelivery: the work already happened durably
        } else {
          report.refused.push(r.reason); // policy / addressee refusals: never acted on, never acked
        }
        continue;
      }
      // 3. Act, then consume (verify → policy → act durably → commit dedup → ack, §13.4).
      if (outcome.kind === "message" && outcome.result.acted) {
        const m = outcome.result.message;
        if (m.type !== "notify" && opts.decide) {
          const decision = opts.decide(m);
          if (decision) {
            try {
              hub.resolveAsAgent(m.id, opts.principal, decision, { session: sessionId, now: now() });
            } catch (e) {
              // Losing the §7 CAS race is a normal outcome (the 409 carries the real terminal);
              // everything else maps to the loud exits. Read through §8.5's fallback so a refining
              // Hub's own 409 code reads as that same lost race — resolve with `?session=` is a
              // presentation touchpoint (§16.3), the row mapHubError resolves against too.
              if (effectiveCode(e, "presentation") !== "already_terminal") mapHubError(e, "presentation");
            }
          }
        }
        outcome.result.commit();
        report.processed.messages++;
      } else if (outcome.kind === "directive" && outcome.result.acted) {
        outcome.result.commit();
        report.processed.directives++;
      } else if (outcome.kind === "response") {
        report.processed.responses++;
      } else if (outcome.kind === "receipt") {
        report.processed.receipts++;
      }
      toAck.push(ackKeyOf(delivery));
    }
    if (toAck.length > 0) {
      try {
        // Ack presenting the session (§8.7): during a held stream this may be the bridge's only
        // client-originated traffic, and a session-less ack renews no lease.
        hub.ackInbox(opts.principal, toAck, { session: sessionId, now: now() });
      } catch (e) {
        mapHubError(e, "presentation");
      }
    }
  }

  // 4. Close the session (§16.3): an orderly exit bounces nothing later and frees the cap.
  try {
    hub.closeSession(sessionId, opts.principal, now());
  } catch (e) {
    mapHubError(e, "session-lifecycle");
  }
  report.closed = true;
  return report;
}
