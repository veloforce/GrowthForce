#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="${1:-$SCRIPT_ROOT}"
cd "$PROJECT_DIR"

LOCKFILE="package-lock.json"
MARKER_FILE="node_modules/.agentstudio-package-lock.sha256"

electron_binary_is_complete() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");

    let packagePath;
    try {
      packagePath = require.resolve("electron/package.json", { paths: [process.cwd()] });
    } catch (error) {
      if (error && error.code === "MODULE_NOT_FOUND") {
        process.exit(0);
      }
      throw error;
    }

    const electronDir = path.dirname(packagePath);
    const pathFile = path.join(electronDir, "path.txt");
    if (!fs.existsSync(pathFile)) {
      process.exit(1);
    }

    const relativeExecutable = fs.readFileSync(pathFile, "utf8").trim();
    if (!relativeExecutable) {
      process.exit(1);
    }

    const executable = path.join(electronDir, "dist", relativeExecutable);
    process.exit(fs.existsSync(executable) ? 0 : 1);
  '
}

ensure_electron_binary() {
  if electron_binary_is_complete; then
    return
  fi

  echo "Electron binary is incomplete. Repairing with npm rebuild electron..."
  if ! node "$SCRIPT_ROOT/scripts/repair-electron.cjs" "$PROJECT_DIR"; then
    echo "Electron binary is still incomplete after npm rebuild electron." >&2
    echo "Check network access and Electron download settings, then retry." >&2
    exit 1
  fi

  if ! electron_binary_is_complete; then
    echo "Electron binary is still incomplete after npm rebuild electron." >&2
    echo "Check network access and Electron download settings, then retry." >&2
    exit 1
  fi

  echo "Electron binary repaired."
}

if [ ! -f "$LOCKFILE" ]; then
  echo "Missing dependency lockfile: $PROJECT_DIR/$LOCKFILE" >&2
  exit 1
fi

LOCK_HASH="$(node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$LOCKFILE")"

if [ -d "node_modules" ] && [ -f "$MARKER_FILE" ] && [ "$(tr -d '\r\n' < "$MARKER_FILE")" = "$LOCK_HASH" ]; then
  echo "npm dependencies are up to date."
  ensure_electron_binary
  exit 0
fi

echo "Synchronizing npm dependencies with package-lock.json..."
npm install --cache .npm-cache
ensure_electron_binary

# npm install may normalize package-lock.json, so record the hash after a successful install.
LOCK_HASH="$(node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$LOCKFILE")"
mkdir -p "node_modules"
MARKER_TMP="${MARKER_FILE}.tmp.$$"
trap 'rm -f "$MARKER_TMP"' EXIT
printf '%s\n' "$LOCK_HASH" > "$MARKER_TMP"
mv "$MARKER_TMP" "$MARKER_FILE"
trap - EXIT
