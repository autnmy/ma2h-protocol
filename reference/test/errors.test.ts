// The Hub error-code vocabulary (issue #43): the ONE code→status table, the unions derived from
// it, and the §8.5 unknown-code fallback matrix split per §16.3's touchpoint rows. Plus the drift
// guard the open `HubErrorCode` union deliberately cannot provide at compile time — a scan of
// `src/**` asserting every emitted code literal is in the table.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HUB_ERROR_STATUS,
  baseCodeForStatus,
  isHubErrorStatus,
  isKnownHubErrorCode,
  statusOfHubErrorCode,
  type HubErrorStatus,
  type HubTouchpoint,
} from "../src/errors.js";
import { Hub, HubError } from "../src/hub.js";

const T0 = 1_786_752_000_000;

const TOUCHPOINTS: HubTouchpoint[] = [
  "presentation",
  "session-lifecycle",
  "own-session-submit",
  "addressed-send",
];
/** Derived, not restated — a class added to the table is then covered here automatically. */
const STATUSES: HubErrorStatus[] = [...new Set(Object.values(HUB_ERROR_STATUS))];

const SRC = new URL("../src/", import.meta.url);
/** The emitter form the drift guard scans for. `matchAll` clones it, so sharing one /g is safe. */
const EMISSION = /new HubError\(\s*"([^"]*)"/g;

test("the table classes every code §8.5 lists, at the status §8.5 lists it under", () => {
  // Transcribed from spec/v0.5.md §8.5's status→code table, pair by pair — a wrong status is as
  // much a drift bug as a missing key, so assert the value and not merely the presence.
  const spec: Record<string, HubErrorStatus> = {
    validation_error: 400,
    version_not_supported: 400,
    unauthenticated: 401,
    agent_id_mismatch: 403,
    not_authorized: 403,
    not_found: 404,
    idempotency_conflict: 409,
    already_terminal: 409,
    gone: 410,
    destination_gone: 410,
    session_closed_by_operator: 410,
    invalid_field: 422,
    unknown_destination: 422,
    rate_limited: 429,
  };
  for (const [code, status] of Object.entries(spec)) {
    assert.equal(statusOfHubErrorCode(code), status, `${code} should class as ${status} (§8.5)`);
  }
});

test("`not_acknowledgeable` classes 409 — §8.5's table omits it, §14.3 supplies the class", () => {
  // "Requires the message to be terminal (a resolution exists) — acking an `open` message is 409."
  assert.equal(statusOfHubErrorCode("not_acknowledgeable"), 409);
});

test("isKnownHubErrorCode recognizes the vocabulary and nothing else", () => {
  for (const code of Object.keys(HUB_ERROR_STATUS)) {
    assert.ok(isKnownHubErrorCode(code), `${code} is in the table`);
  }
  assert.equal(isKnownHubErrorCode("gonee"), false, "a typo is not a known code");
  assert.equal(isKnownHubErrorCode(""), false);
  assert.equal(isKnownHubErrorCode(undefined), false);
  // Inherited Object properties must not read as vocabulary (hasOwn, not `in`).
  assert.equal(isKnownHubErrorCode("toString"), false);
  assert.equal(isKnownHubErrorCode("constructor"), false);
});

test("statusOfHubErrorCode declines to class a code outside the vocabulary", () => {
  assert.equal(statusOfHubErrorCode("gone"), 410);
  assert.equal(statusOfHubErrorCode("downstream_custom_code"), undefined);
  assert.equal(statusOfHubErrorCode(undefined), undefined);
});

test("the §16.3 split: an unrecognized 410 reads as `gone` presenting, `destination_gone` sending", () => {
  assert.equal(baseCodeForStatus(410, "presentation"), "gone");
  assert.equal(baseCodeForStatus(410, "own-session-submit"), "destination_gone");
  assert.equal(baseCodeForStatus(410, "addressed-send"), "destination_gone");
});

test("a session-lifecycle call gets NO 410 or 409 reading — §16.3 lists neither register nor close", () => {
  // §16.3's presentation row is drain / ack / resolve / stream connect. Registration has no session
  // to present and close is an idempotent terminal transition, so the spec gives no
  // absent-refinement reading here — and inventing `gone` would tell a caller to re-register.
  assert.equal(baseCodeForStatus(410, "session-lifecycle"), undefined);
  assert.equal(baseCodeForStatus(409, "session-lifecycle"), undefined);
  // The credential and request classes are about the caller, not the session: still read here.
  assert.equal(baseCodeForStatus(401, "session-lifecycle"), "unauthenticated");
  assert.equal(baseCodeForStatus(403, "session-lifecycle"), "not_authorized");
  assert.equal(baseCodeForStatus(404, "session-lifecycle"), "not_found");
  assert.equal(baseCodeForStatus(429, "session-lifecycle"), "rate_limited");
});

test("the §8.5 409 split: `already_terminal` presenting, `idempotency_conflict` on a submit (§8.1)", () => {
  // §8.5's 409 row carries both base codes and §8.1 splits them by touchpoint: a replay with a
  // differing payload is a SUBMIT conflict; cancel/resolve-after-terminal is what a presentation
  // touchpoint reaches. Reading a submit's unrecognized 409 as `already_terminal` would tell a
  // caller its message was resolved when the Hub actually refused the replay.
  assert.equal(baseCodeForStatus(409, "presentation"), "already_terminal");
  assert.equal(baseCodeForStatus(409, "own-session-submit"), "idempotency_conflict");
  assert.equal(baseCodeForStatus(409, "addressed-send"), "idempotency_conflict");
});

test("an unrecognized 422 reads as `invalid_field` at EVERY touchpoint — §8.5 states it flatly", () => {
  // §8.5: "an unrecognized `422` as `invalid_field`", with no touchpoint split.
  // `unknown_destination` is the meaning of that RECOGNIZED code, never the fallback for an
  // unrecognized sibling — reading an addressed send's unrecognized 422 as `unknown_destination`
  // would send a client rerouting away from a destination that was fine.
  for (const touchpoint of TOUCHPOINTS) {
    assert.equal(baseCodeForStatus(422, touchpoint), "invalid_field", `422 at ${touchpoint}`);
  }
});

test("baseCodeForStatus stays silent on a class §8.5 does not define", () => {
  assert.equal(baseCodeForStatus(500, "presentation"), undefined);
  assert.equal(baseCodeForStatus(200, "presentation"), undefined);
  assert.equal(baseCodeForStatus(undefined, "presentation"), undefined);
  assert.equal(isHubErrorStatus(500), false);
  assert.equal(isHubErrorStatus(410), true);
});

test("every base code the matrix names is itself vocabulary, and classes back to its own row", () => {
  // Catches a matrix row that borrowed a code from the wrong status class — the transcription
  // error a per-row eyeball would miss. A cell may be `undefined` (a touchpoint §8.5 gives no
  // reading); when it names a code, that code must belong to the row it sits in.
  let named = 0;
  for (const status of STATUSES) {
    for (const touchpoint of TOUCHPOINTS) {
      const base = baseCodeForStatus(status, touchpoint);
      if (base === undefined) continue;
      named++;
      assert.ok(isKnownHubErrorCode(base), `${base} must be in the table`);
      assert.equal(
        statusOfHubErrorCode(base),
        status,
        `${status}/${touchpoint} base code ${base} must belong to the ${status} class`,
      );
    }
  }
  // Guard the `continue` above: a matrix accidentally emptied would otherwise pass vacuously.
  assert.ok(named >= 30, `expected most cells to name a base code, got ${named}`);
});

// ---- HubError carries the class (U2) ----

test("HubError derives its §8.5 status from its code", () => {
  assert.equal(new HubError("gone", "msg").status, 410);
  assert.equal(new HubError("invalid_field", "msg").status, 422);
  assert.equal(new HubError("session_closed_by_operator", "msg").status, 410);
});

test("every code in the table derives its own status on a real HubError", () => {
  for (const [code, status] of Object.entries(HUB_ERROR_STATUS)) {
    assert.equal(new HubError(code, "msg").status, status, `HubError(${code}).status`);
  }
});

test("a code outside the vocabulary carries no class — and an explicit override supplies one", () => {
  assert.equal(new HubError("downstream_custom_code", "msg").status, undefined);
  assert.equal(new HubError("downstream_custom_code", "msg", undefined, 410).status, 410);
});

test("the class rides a REAL Hub emission, not just a hand-built HubError", () => {
  // Constructor-level tests prove the derivation; this proves the emission path actually reaches
  // it — the ~50 `new HubError(...)` sites pass no status, so a regression that dropped the
  // derivation would still pass every test above.
  const hub = new Hub({ signingKey: "hub-errors-key-0123456789abcdef0123456789abcdef", now: () => T0 });
  assert.throws(
    () => hub.cancel("msg_does-not-exist", "deploybot/dev-team", T0),
    (e: unknown) => e instanceof HubError && e.code === "not_found" && e.status === 404,
  );
});

test("the status parameter does not disturb `details` (§8.4's 409 body)", () => {
  const e = new HubError("already_terminal", "msg", { id: "msg_1", status: "resolved" }, 409);
  assert.deepEqual(e.details, { id: "msg_1", status: "resolved" });
  assert.equal(e.status, 409);
  assert.equal(e.code, "already_terminal");
  assert.equal(e.name, "HubError");
  assert.ok(e instanceof Error);
});

// ---- Emitter drift guard (U4) ----

// A floor just under the current site count (52 at the time of writing). Its whole job is to fail
// the build if the regex below stops matching and quietly turns this guard into a no-op — that
// failure mode drops the count to roughly zero, so the small margin absorbs a legitimate removal
// without blunting the check. Never lower it to make a broken scan pass.
const MIN_EMISSION_SITES = 50;

test("every error code emitted in src/ is in the table", () => {
  const found: { code: string; file: string }[] = [];
  for (const file of readdirSync(fileURLToPath(SRC)).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(new URL(file, SRC), "utf8");
    for (const m of text.matchAll(EMISSION)) {
      found.push({ code: m[1] ?? "", file });
    }
  }

  assert.ok(
    found.length >= MIN_EMISSION_SITES,
    `scanned only ${found.length} emission sites (floor ${MIN_EMISSION_SITES}) — the scan regex ` +
      `has probably stopped matching, which would silently disable this guard`,
  );

  const unknown = found.filter((f) => !isKnownHubErrorCode(f.code));
  assert.deepEqual(
    unknown,
    [],
    `code(s) emitted but absent from HUB_ERROR_STATUS: ${unknown.map((u) => `"${u.code}" (${u.file})`).join(", ")}`,
  );
});

test("the scan covers the kill-switch marker, which is emitted via a helper", () => {
  // `session_closed_by_operator` is minted in `Hub.operatorClosedError`, not at its throw sites —
  // pin that the scan still sees it, so a refactor to a computed code cannot quietly drop it.
  const hub = readFileSync(new URL("hub.ts", SRC), "utf8");
  const codes = [...hub.matchAll(EMISSION)].map((m) => m[1]);
  assert.ok(codes.includes("session_closed_by_operator"), "the marker must be a scanned literal");
});
