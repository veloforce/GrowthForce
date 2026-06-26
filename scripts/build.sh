#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash "$ROOT_DIR/scripts/sync-dependencies.sh" "$ROOT_DIR"

export AGENTSTUDIO_DEBUG_LOGS="${AGENTSTUDIO_DEBUG_LOGS:-1}"
npm run generate:icons
npm run build:xhs-sidecar
npm run compile

export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"

case "$PLATFORM" in
  darwin)
    npx electron-builder --mac dmg "--${ARCH}"
    ;;
  win32)
    npx electron-builder --win nsis --x64
    ;;
  *)
    echo "Packaging is only configured for macOS and Windows. Compile completed for ${PLATFORM}-${ARCH}."
    ;;
esac
