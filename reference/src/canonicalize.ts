// RFC 8785 JSON Canonicalization Scheme (JCS) — the canonical serialization A2H signs
// (spec §9.2): the flat `signed_context` AND the `payload_sha256` pre-image
// `{ response, state }`, which (unlike signed_context) can carry numbers, arrays, and nesting.
//
// Numbers: `JSON.stringify(n)` is ECMAScript `Number::toString`, which RFC 8785 §3.2.2.3 is
// *defined as* — so this is byte-exact RFC 8785 for every finite IEEE-754 double (proven by the
// `dp-004` numeric vector: `1e-7`→`1e-7`, `1e21`→`1e+21`, `-0`→`0`, keys sorted). A signed numeric
// payload value MUST therefore stay within double range: an integer beyond ±(2^53-1) cannot
// round-trip and MUST be carried as a string. A non-JS implementation MUST use a vetted JCS library
// whose number formatting matches `Number::toString` (and full Unicode normalization), or its
// `payload_sha256` will diverge from a conformant signer's.

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(); // RFC 8785: sort by UTF-16 code units
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default:
      throw new Error("JCS: unsupported type " + typeof value);
  }
}
