#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TAG="${1:-v0.1.13}"
REMOTE="${REMOTE:-origin}"

usage() {
  echo "Usage: bash scripts/push-release-tag.sh [tag]"
  echo "Example: bash scripts/push-release-tag.sh v0.1.13"
  echo
  echo "Creates a release commit for package.json/package-lock.json, pushes the current branch,"
  echo "then creates and pushes the annotated release tag."
}

case "$TAG" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must run inside a git repository." >&2
  exit 1
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "Git remote '$REMOTE' does not exist." >&2
  exit 1
fi

if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid release tag '$TAG'. Expected format: vMAJOR.MINOR.PATCH" >&2
  exit 1
fi

if git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Remote tag '$TAG' already exists on '$REMOTE'." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or stash them before starting a release." >&2
  exit 1
fi

TAG_VERSION="${TAG#v}"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
CURRENT_BRANCH="$(git branch --show-current)"

if [ -z "$CURRENT_BRANCH" ]; then
  echo "Cannot release from detached HEAD." >&2
  exit 1
fi

if [ "$PACKAGE_VERSION" != "$TAG_VERSION" ]; then
  npm version "$TAG_VERSION" --no-git-tag-version
  git add package.json package-lock.json
  git commit -m "chore: release $TAG"
  echo "Created release commit for $TAG."
else
  echo "package.json already uses version $TAG_VERSION."
fi

HEAD_SHA="$(git rev-parse HEAD)"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAG_SHA="$(git rev-list -n 1 "$TAG")"
  if [ "$TAG_SHA" != "$HEAD_SHA" ]; then
    echo "Local tag '$TAG' points to $TAG_SHA, but HEAD is $HEAD_SHA." >&2
    exit 1
  fi
  echo "Local tag '$TAG' already points to HEAD."
else
  git tag -a "$TAG" -m "Release $TAG"
  echo "Created annotated tag '$TAG' at $HEAD_SHA."
fi

git push "$REMOTE" "$CURRENT_BRANCH"
git push "$REMOTE" "refs/tags/$TAG"
echo "Pushed branch '$CURRENT_BRANCH' and tag '$TAG' to '$REMOTE'."
