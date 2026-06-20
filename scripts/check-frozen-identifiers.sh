#!/usr/bin/env bash
#
# Frozen-identifier guard. Catches accidental drift of the protocol's wire identifiers and the
# canonical schema domain — the kind of mistake a well-meaning "consistency cleanup" or a blanket
# find-replace introduces. Run in CI alongside the conformance tests.
#
# What it asserts:
#   1. Every JSON Schema `$id` is on the canonical domain (ahcpprotocol.org), never the old one.
#   2. The reference resolver BASE matches that domain (or $ref resolution silently breaks).
#   3. The frozen wire identifiers still exist verbatim (a rename would break interop + vectors).
#   4. The old domain does not reappear on the wire surface (schemas / reference src / examples /
#      vectors) — those must stay on the canonical domain even though the migration docs reference it.
#
# Adjust CANON_DOMAIN / the frozen-token list here when an intentional, versioned change lands.

set -uo pipefail
cd "$(dirname "$0")/.."

CANON_DOMAIN="ahcpprotocol.org"
OLD_DOMAIN="a2hprotocol.org"
FROZEN_WIRE_TOKENS=("a2h_version" "A2H-Signature" "A2H_CALLBACK_SECRET" "x-a2h-sensitive")

fail=0
err() { echo "::error::$1"; fail=1; }

# 1) Schema $id on the canonical domain.
for f in schema/*/*.schema.json; do
  id_line=$(grep -m1 '"\$id"' "$f" || true)
  if [ -z "$id_line" ]; then
    err "$f: missing \$id"
  elif printf '%s' "$id_line" | grep -q "$OLD_DOMAIN"; then
    err "$f: schema \$id still on $OLD_DOMAIN (must be $CANON_DOMAIN)"
  elif ! printf '%s' "$id_line" | grep -q "$CANON_DOMAIN/schema/"; then
    err "$f: \$id not on $CANON_DOMAIN/schema/ — got: $id_line"
  fi
done

# 2) Reference resolver BASE matches the canonical schema domain.
grep -q "const BASE = \"https://$CANON_DOMAIN/schema/" reference/src/envelope.ts \
  || err "reference/src/envelope.ts BASE must be https://$CANON_DOMAIN/schema/... (it resolves \$refs)"

# 3) Frozen wire identifiers still present (a rename would break interop + conformance vectors).
for tok in "${FROZEN_WIRE_TOKENS[@]}"; do
  grep -rq -- "$tok" spec/ schema/ \
    || err "frozen wire identifier '$tok' not found in spec/ or schema/ — was it renamed?"
done

# 4) Old domain must not reappear on the wire surface.
wire_hits=$(grep -rIl "$OLD_DOMAIN" schema/ reference/src/ examples/ conformance/vectors/ 2>/dev/null || true)
if [ -n "$wire_hits" ]; then
  echo "$wire_hits" | sed 's/^/  stale: /'
  err "stale $OLD_DOMAIN on the wire surface (schema / reference src / examples / vectors)"
fi

if [ "$fail" -ne 0 ]; then
  echo "frozen-identifier check FAILED"
  exit 1
fi
echo "frozen-identifier check passed (schema \$id on $CANON_DOMAIN; wire identifiers intact)"
