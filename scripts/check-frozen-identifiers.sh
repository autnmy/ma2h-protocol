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
#   3. asserts the frozen wire identifiers still exist verbatim on EVERY live version (a rename breaks
#      interop + vectors);
#   4. asserts neither retired identity (`a2h` or `ahcp`) has crept back onto the wire surface (schemas /
#      reference src / examples / vectors / plugin skills);
#   5. asserts the plugin skills' hand-pinned ma2h.org URLs still name the current version.
#
# Adjust CANON_DOMAIN / the token lists here when an intentional, versioned change lands.

set -uo pipefail
cd "$(dirname "$0")/.."

CANON_DOMAIN="ma2h.org"
# Every CURRENTLY-LIVE normative surface, each checked INDEPENDENTLY (assertion 3). Two properties are
# load-bearing:
#   - Listing versions, rather than grepping all of spec/ + schema/, stops a historical v0.1/v0.2/v0.3
#     file from satisfying a token after a live contract has been renamed.
#   - v0.5 does NOT replace v0.4 here. v0.5 is additive — "alongside the unchanged v0.4 legs"
#     (spec/v0.5.md) — and reference/src/conformance.ts still validates every non-`v0.5/` vector against
#     the v0.4 snapshot, so both are live and both need guarding. Dropping v0.4 would not tighten this
#     check, only move its blind spot: a single stale pin is what let the entire v0.5 surface go
#     unchecked (#44).
# Add a version once its spec + schema are live; remove one only when nothing validates against it.
LIVE_VERSIONS=("v0.4" "v0.5")
# Newest live version — what the plugin skills must pin their ma2h.org URLs to (assertion 5). Derived
# from the list above so the two cannot drift apart.
CURRENT_VERSION="${LIVE_VERSIONS[${#LIVE_VERSIONS[@]}-1]}"
# Wire identifiers that MUST remain present in every live spec + schema (a rename breaks interop).
FROZEN_WIRE_TOKENS=("ma2h_version" "MA2H-Signature" "MA2H_CALLBACK_SECRET" "x-ma2h-sensitive" ".well-known/ma2h")
# Retired identities (a2h, then ahcp) that must never reappear on the wire surface.
FORBIDDEN_TOKENS=(
  "a2hprotocol.org" "a2h_version" "A2H-Signature" "A2H_CALLBACK_SECRET" "x-a2h-sensitive" "A2HSEALv1" ".well-known/a2h"
  "ahcpprotocol.org" "ahcp_version" "AHCP-Signature" "AHCP_CALLBACK_SECRET" "x-ahcp-sensitive" "AHCPSEALv1" ".well-known/ahcp"
)
# `plugins/` belongs on this list even though nothing there is normative: the skills carry wire
# identifiers verbatim and exist to be copied into implementers' codebases, so a retired identifier
# reintroduced there is propagated downstream by design rather than caught (#36).
WIRE_PATHS=("schema/" "reference/src/" "examples/" "conformance/vectors/" "plugins/")

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

# 3) Frozen wire identifiers still present on EACH live surface. The nesting — version outer, token
#    inner — is the correctness property: one grep per (version, token) pair means a token surviving in
#    v0.4 cannot vouch for v0.5. A single grep spanning both surfaces at once would re-introduce, one
#    level up, exactly the masking this scoping exists to prevent.
for ver in "${LIVE_VERSIONS[@]}"; do
  spec="spec/$ver.md"
  schema_dir="schema/$ver"
  # Report the missing PATH rather than every token as renamed — a stale LIVE_VERSIONS entry should say
  # so plainly instead of emitting five misleading token failures.
  [ -f "$spec" ] || { err "$spec missing — is '$ver' still a live version?"; continue; }
  [ -d "$schema_dir" ] || { err "$schema_dir/ missing — is '$ver' still a live version?"; continue; }
  for tok in "${FROZEN_WIRE_TOKENS[@]}"; do
    # spec + schema as a union WITHIN a version: MA2H-Signature and MA2H_CALLBACK_SECRET are spec-only
    # in every version, so demanding each token in both files would fail on a correct tree.
    grep -rq -- "$tok" "$spec" "$schema_dir" \
      || err "frozen wire identifier '$tok' missing from the $ver surface ($spec / $schema_dir/) — was it renamed?"
  done
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
    # printf, not `sed s/…/…/` — `.well-known/a2h` and `.well-known/ahcp` contain the delimiter, so a
    # sed substitution built from $tok breaks on exactly the two tokens most likely to show up in the
    # copied skills text, printing a sed error where the offending filename should be.
    while IFS= read -r hit; do
      printf "  stale '%s' in: %s\n" "$tok" "$hit"
    done <<< "$hits"
    err "retired identifier '$tok' found on the wire surface (must be the ma2h equivalent)"
  fi
done

# 5) The skills pin ma2h.org spec/schema URLs by hand, so a version bump that updates the spec but
#    forgets them ships stale copy-paste text to implementers. This matches URL-SHAPED references ONLY.
#    That restriction is load-bearing, not incidental: bare prose mentions of superseded versions are
#    legitimate and common here ("the v0.4 inbound leg", and plugin.json's own description), so a check
#    keyed on the bare version string would fail on a correct tree and get deleted rather than fixed.
#    Nothing is stale today — this guard is preventative, and is expected to stay silent until the next
#    version bump.
pinned_urls=$(grep -rInoE "ma2h\.org/(spec|schema)/v[0-9]+\.[0-9]+" plugins/ 2>/dev/null || true)
if [ -z "$pinned_urls" ]; then
  # Zero matches is NOT a pass. plugins/ carries these URLs today, so an empty result means the path
  # moved or the pattern stopped matching — i.e. this assertion quietly became a no-op. That is the
  # same way the stale v0.4 pin went unnoticed (#44), so it fails loudly instead.
  err "no ma2h.org spec/schema URLs found under plugins/ — did the path move, or the skills stop pinning?"
else
  while IFS= read -r hit; do
    # hit is file:line:match — the pinned version is the trailing path segment. Compared as a string
    # rather than folded into a regex, so the `.` in `v0.5` cannot match `v0x5`.
    [ "${hit##*/}" = "$CURRENT_VERSION" ] && continue
    printf "  pinned %s in: %s\n" "${hit##*/}" "${hit%:*}"
    err "plugins/ pins a ma2h.org URL for ${hit##*/}, but the current version is $CURRENT_VERSION"
  done <<< "$pinned_urls"
fi

if [ "$fail" -ne 0 ]; then
  echo "frozen-identifier check FAILED"
  exit 1
fi
echo "frozen-identifier check passed (schema \$id on $CANON_DOMAIN; ma2h wire identifiers intact across ${LIVE_VERSIONS[*]}; no a2h/ahcp on the wire surface; plugins/ URLs pinned to $CURRENT_VERSION)"
