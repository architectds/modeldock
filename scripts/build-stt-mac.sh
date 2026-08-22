#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/dist/modeldock-stt-helper"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/modeldock-stt.XXXXXX")"
SDK_VERSION="$(xcrun --sdk macosx --show-sdk-platform-version 2>/dev/null || sw_vers -productVersion)"
DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-$SDK_VERSION}"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

mkdir -p "$ROOT/dist"
for ARCH in arm64 x86_64; do
  swiftc -parse-as-library -O -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
    -o "$BUILD_DIR/modeldock-stt-helper-$ARCH" "$ROOT/scripts/stt-mac-helper.swift" \
    -framework Speech \
    -framework AVFoundation
done
lipo -create "$BUILD_DIR/modeldock-stt-helper-arm64" "$BUILD_DIR/modeldock-stt-helper-x86_64" -output "$OUT"

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
