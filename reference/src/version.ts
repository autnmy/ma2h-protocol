// Canonical wire-version constant (spec §10, issue #41). A standalone module so downstream
// consumers can vendor it byte-for-byte and import the one definition instead of re-declaring
// the literal wherever an envelope is minted.

/**
 * The `ma2h_version` this implementation EMITS on every envelope it mints (spec §10) — major 0,
 * up to minor 5. This is "the version this implementation emits", NOT a Hub's accepted-version
 * floor: those are different values with different semantics. What a Hub still ACCEPTS is
 * governed separately (e.g. `hub.ts`'s `PAYLOAD_BOUND_SINCE_MINOR` anchors the §9.2 push-parity
 * floor at minor 3, so a 0.3 push is still accepted while 0.5 is emitted). Conflating the two —
 * or re-declaring this literal per call site — is the drift issue #41 / oh-hai#712 documents:
 * downstream declared the wire version in five places and advertised `v0.3` while emitting `0.5`.
 */
export const MA2H_VERSION = "0.5";
