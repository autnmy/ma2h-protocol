// RFC 8785 JSON Canonicalization Scheme (JCS) — the canonical serialization AHCP signs
// (spec §9.2): the flat `signed_context` AND the `payload_sha256` pre-image
// `{ response, state }`, which (unlike signed_context) can carry numbers, arrays, and nesting.
//
// Numbers: `JSON.stringify(n)` is ECMAScript `Number::toString`, which RFC 8785 §3.2.2.3 is
// *defined as* — so this is byte-exact RFC 8785 for any finite number, ordinary decimals included
// (`1e-7`→`1e-7`, `-0`→`0`, `-0.001`→`-0.001`; proven by the `dp-004` vector). A JSON number is an
// IEEE-754 double, so an application needing an integer beyond ±(2^53-1) *exactly* must carry it as a
// string (a bare number would silently round) — but any in-range number signs deterministically.
//
// Strings: RFC 8785 §3.1 preserves string content as-is and does NOT apply Unicode normalization;
// only the §3.2.2.2 escaping is canonical. A non-JS implementation MUST use a vetted JCS library
// (matching `Number::toString` + that string handling), or its `payload_sha256` will diverge.

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
