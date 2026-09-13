// Canonical wire-version constant (spec §10, issue #41). A standalone module so downstream
// consumers can vendor it byte-for-byte and import the one definition instead of re-declaring
// the literal wherever an envelope is minted.

/**
 * The `ma2h_version` this implementation EMITS on every envelope it mints (spec §10) — major 0,
 * up to minor 6. This is "the version this implementation emits", NOT a Hub's accepted-version
 * floor: those are different values with different semantics. What a Hub still ACCEPTS is
 * governed separately (e.g. `hub.ts`'s `PAYLOAD_BOUND_SINCE_MINOR` anchors the §9.2 push-parity
 * floor at minor 3, so a 0.3 push is still accepted while 0.6 is emitted). Conflating the two —
 * or re-declaring this literal per call site — is the drift issue #41 / oh-hai#712 documents:
 * downstream declared the wire version in five places and advertised `v0.3` while emitting `0.5`.
 *
 * A THIRD concept lives in `wire.ts` and deliberately does NOT read this constant (issue #45):
 * the client envelope builders stamp the LOWEST minor the submitted envelope's features require
 * (`wireVersionFor` — base `"0.3"`, addressed minimum `"0.5"`). This constant names the HIGHEST
 * minor this implementation speaks — what HUB-minted envelopes (Responses, directives, receipts)
 * carry. Lowest-minor-required is a static property of an envelope's features, so coupling the
 * builders' rule to this constant would stamp `0.6` on v0.5-feature envelopes — which is no longer
 * hypothetical, since the v0.6 bump is exactly the event that comment anticipated. `wireVersionFor`
 * stays decoupled and gained ONE row of its own instead: `permissions.allow_edit: true` lifts an
 * envelope to `"0.6"`, because that field is v0.6 vocabulary a Hub ignores below minor 6 (spec
 * §5.2) — a builder must not emit a request whose own feature a conformant Hub is required to
 * discard. The v0.6 CORRECTIONS add no row: they are shapes a Hub refuses, not features an envelope
 * opts into, so they raise no envelope's required minor. That is the distinction coupling the two
 * rules would have erased — the #712 drift class, recreated inside its own fix.
 */
export const MA2H_VERSION = "0.6";
