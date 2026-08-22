#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/dist/modeldock-stt-helper"

mkdir -p "$ROOT/dist"
swiftc -parse-as-library -O -o "$OUT" "$ROOT/scripts/stt-mac-helper.swift" \
  -framework Speech \
  -framework AVFoundation

echo "built $OUT"

if command -v security >/dev/null 2>&1; then
  IDENTITY=$(security find-identity -v -p codesigning |
    grep 'Developer ID Application:' |
    sed -E 's/.*"([^"]+)".*/\1/' |
    head -1)

  if [ -n "$IDENTITY" ]; then
    if codesign --force --options runtime --timestamp --sign "$IDENTITY" "$OUT"; then
      echo "signed with $IDENTITY"
    else
      echo "warning: codesign failed; continuing with the ad-hoc built binary. Set MODELDOCK_REQUIRE_STT_SIGN=1 to fail instead." >&2
      if [ "${MODELDOCK_REQUIRE_STT_SIGN:-0}" = "1" ]; then
        exit 1
      fi
    fi
  else
    echo "no Developer ID Application identity found; left ad-hoc/unsigned"
  fi
fi
