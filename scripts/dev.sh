#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODEL_HTTP_LOG_ENV=""
for arg in "$@"; do
  case "$arg" in
    --debug)
      MODEL_HTTP_LOG_ENV="AGENTSTUDIO_DEV_MODEL_HTTP_LOGS=dev.sh"
      ;;
    --help|-h)
      echo "Usage: bash scripts/dev.sh [--debug]"
      echo "  --debug  Enable dev-only model HTTP proxy logging."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: bash scripts/dev.sh [--debug]" >&2
      exit 1
      ;;
  esac
done

bash "$ROOT_DIR/scripts/sync-dependencies.sh" "$ROOT_DIR"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    XHS_SIDECAR="resources/connectors/xhs/bin/darwin/arm64/xhs-cli/xhs-cli"
    ;;
  Darwin-x86_64)
    XHS_SIDECAR="resources/connectors/xhs/bin/darwin/x64/xhs-cli/xhs-cli"
    ;;
  MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64)
    XHS_SIDECAR="resources/connectors/xhs/bin/win32/x64/xhs-cli/xhs-cli.exe"
    ;;
  *)
    XHS_SIDECAR=""
    ;;
esac

if [ -n "$XHS_SIDECAR" ] && [ ! -x "$XHS_SIDECAR" ]; then
  if [ "${AGENTSTUDIO_XHS_ALLOW_SOURCE_CLI:-}" = "1" ]; then
    echo "Skipping automatic XHS sidecar build because AGENTSTUDIO_XHS_ALLOW_SOURCE_CLI=1."
  else
    echo "Missing XHS sidecar: $XHS_SIDECAR"
    echo "Checking for Python 3.11+ and building the XHS sidecar..."
    npm run build:xhs-sidecar
    if [ ! -x "$XHS_SIDECAR" ]; then
      echo "XHS sidecar build completed without producing an executable: $XHS_SIDECAR" >&2
      exit 1
    fi
  fi
fi

npm run build:tools

npx concurrently -k \
  "vite --host 127.0.0.1" \
  "tsc -p tsconfig.node.json --watch --preserveWatchOutput" \
  "wait-on tcp:5173 dist/main/main.js dist/preload/preload.js dist/agent/agent.js && cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 $MODEL_HTTP_LOG_ENV electron ."
