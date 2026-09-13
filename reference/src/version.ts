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
 * is deliberately unchanged by it: v0.6 narrows the `ask` contract and defines `allow_edit`, and
 * none of that raises the minor an envelope REQUIRES (an `allow_edit` request degrades safely on a
 * pre-0.6 Hub — see spec §5.2), so the lowest-minor-required rule still bottoms out at "0.3"/"0.5".
 * The #712 drift class, recreated inside its own fix, is what coupling them would have cost.
 */
export const MA2H_VERSION = "0.6";
