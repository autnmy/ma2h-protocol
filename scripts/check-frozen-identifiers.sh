#!/usr/bin/env bash
#
# Frozen-identifier guard. Catches accidental drift of the protocol's wire identifiers and the
# canonical schema domain — the kind of mistake a well-meaning "consistency cleanup" or a blanket
# find-replace introduces. Run in CI alongside the conformance tests.
#
# The protocol identity is uniformly `ma2h` (renamed from `a2h`, then briefly `ahcp`; see MIGRATION.md).
# This guard:
#   1. asserts every JSON Schema `$id` is on the canonical domain (ma2h.org);
#   2. asserts the reference resolver BASE matches that domain (or $ref resolution silently breaks);
#   3. asserts the frozen wire identifiers still exist verbatim (a rename breaks interop + vectors);
#   4. asserts neither retired identity (`a2h` or `ahcp`) has crept back onto the wire surface (schemas /
#      reference src / examples / vectors).
#
# Adjust CANON_DOMAIN / the token lists here when an intentional, versioned change lands.

set -uo pipefail
cd "$(dirname "$0")/.."

CANON_DOMAIN="ma2h.org"
# The CURRENT (active) normative surface. Scoping here is deliberate: grepping all of spec/ + schema/
# lets historical v0.1/v0.2/v0.3 files satisfy a token even after the live v0.4 contract is renamed.
CURRENT_SPEC="spec/v0.4.md"
CURRENT_SCHEMA_DIR="schema/v0.4"
# Wire identifiers that MUST remain present in the current spec + schema (a rename breaks interop).
FROZEN_WIRE_TOKENS=("ma2h_version" "MA2H-Signature" "MA2H_CALLBACK_SECRET" "x-ma2h-sensitive" ".well-known/ma2h")
# Retired identities (a2h, then ahcp) that must never reappear on the wire surface.
FORBIDDEN_TOKENS=(
  "a2hprotocol.org" "a2h_version" "A2H-Signature" "A2H_CALLBACK_SECRET" "x-a2h-sensitive" "A2HSEALv1" ".well-known/a2h"
  "ahcpprotocol.org" "ahcp_version" "AHCP-Signature" "AHCP_CALLBACK_SECRET" "x-ahcp-sensitive" "AHCPSEALv1" ".well-known/ahcp"
)
WIRE_PATHS=("schema/" "reference/src/" "examples/" "conformance/vectors/")

fail=0
err() { echo "::error::$1"; fail=1; }

# 1) Schema $id on the canonical domain.
for f in schema/*/*.schema.json; do
  id_line=$(grep -m1 '"\$id"' "$f" || true)
  if [ -z "$id_line" ]; then
    err "$f: missing \$id"
  elif ! printf '%s' "$id_line" | grep -q "$CANON_DOMAIN/schema/"; then
    err "$f: \$id not on $CANON_DOMAIN/schema/ — got: $id_line"
  fi
done

# 2) Reference resolver BASE matches the canonical schema domain.
grep -q "const BASE = \"https://$CANON_DOMAIN/schema/" reference/src/envelope.ts \
  || err "reference/src/envelope.ts BASE must be https://$CANON_DOMAIN/schema/... (it resolves \$refs)"

# 3) Frozen wire identifiers still present on the CURRENT surface (scoped so historical specs/schemas
#    can't mask a rename of the live v0.3 interoperability contract).
for tok in "${FROZEN_WIRE_TOKENS[@]}"; do
  grep -rq -- "$tok" "$CURRENT_SPEC" "$CURRENT_SCHEMA_DIR" \
    || err "frozen wire identifier '$tok' missing from the current surface ($CURRENT_SPEC / $CURRENT_SCHEMA_DIR/) — was it renamed?"
done
# State-seal magic lives in the reference implementation, not spec/schema. Renaming it silently breaks
# every sealed resume token, so it is frozen too.
grep -q "MA2HSEALv1" reference/src/state-seal.ts \
  || err "state-seal magic 'MA2HSEALv1' missing from reference/src/state-seal.ts — was it renamed?"

# 4) Neither retired identity (`a2h` / `ahcp`) may reappear on the wire surface.
#    NOTE: `-w` (whole-word) is load-bearing — the live identity `MA2H` literally CONTAINS `A2H`
#    (e.g. `ma2h_version` ⊃ `a2h_version`, `MA2HSEALv1` ⊃ `A2HSEALv1`). A plain substring grep
#    would flag every legitimate `ma2h` token. `-w` rejects an `a2h` match preceded by the word char
#    `m`/`M` (i.e. inside `ma2h`) while still catching a standalone retired token (preceded by `"` / `/`
#    / whitespace). `-F` keeps the `.` in `a2hprotocol.org` literal rather than a regex wildcard.
for tok in "${FORBIDDEN_TOKENS[@]}"; do
  hits=$(grep -rIlwF -- "$tok" "${WIRE_PATHS[@]}" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "$hits" | sed "s/^/  stale '$tok' in: /"
    err "retired identifier '$tok' found on the wire surface (must be the ma2h equivalent)"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "frozen-identifier check FAILED"
  exit 1
fi
echo "frozen-identifier check passed (schema \$id on $CANON_DOMAIN; ma2h wire identifiers intact; no a2h/ahcp on the wire surface)"
