#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  echo "Usage: bash scripts/tag.sh"
  echo "Example: package.json version 0.1.13 -> npm run release:tag -- v0.1.14"
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "Unknown argument: $1" >&2
    usage >&2
    exit 1
    ;;
esac

CURRENT_VERSION="$(node -p "require('./package.json').version")"

if ! [[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package.json version '$CURRENT_VERSION' is not a plain MAJOR.MINOR.PATCH version." >&2
  exit 1
fi

IFS="." read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEXT_PATCH=$((PATCH + 1))
NEXT_TAG="v${MAJOR}.${MINOR}.${NEXT_PATCH}"

echo "Current package version: $CURRENT_VERSION"
echo "Next release tag: $NEXT_TAG"

npm run release:tag -- "$NEXT_TAG"
