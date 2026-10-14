#!/bin/bash
# Deploy the marketplace Worker with version bumping
# Usage: ./scripts/deploy.sh [patch|minor|major] --env [staging|production]

set -e

# Pin wrangler's config dir to the Nimbalyst OAuth profile so deploys can't
# accidentally land on whatever Cloudflare account is selected in the
# default config. Mirrors the package.json scripts.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config/nimbalyst}"

BUMP_TYPE="${1:-patch}"
shift || true

cd "$(dirname "$0")/.."

# /health reports the commit this deploy was built from, and worker-status.mjs
# diffs from it, so uncommitted Worker sources would ship without a commit.
DIRTY=$(git status --porcelain -- src wrangler.toml package.json)
if [[ -n "$DIRTY" ]]; then
  echo "Uncommitted Worker sources; commit them first:"
  echo "$DIRTY"
  exit 1
fi
GIT_COMMIT=$(git rev-parse HEAD)

# Bump version in package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [patch|minor|major] --env [staging|production]"; exit 1 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# Update package.json version
node -e "
const pkg = require('./package.json');
pkg.version = '${NEW_VERSION}';
require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "Deploying marketplace Worker v${NEW_VERSION} (${GIT_COMMIT:0:9})..."

# --var, not --define: the Worker reads env.VERSION, which --define never
# reaches, so /health used to report wrangler.toml's placeholder forever.
pnpm exec wrangler deploy --var "VERSION:${NEW_VERSION}" --var "GIT_COMMIT:${GIT_COMMIT}" "$@"

echo ""
echo "Deployed marketplace Worker v${NEW_VERSION}"
echo ""
echo "Verify: curl -s https://extensions.nimbalyst.com/health"
echo ""
# No git tag: tags in this repository reach the releases feed the desktop
# app's update check reads. /health's commit is the deploy record instead.
echo "Commit the version bump:"
echo "  git add packages/marketplace/package.json"
echo "  git commit -m \"chore: deploy marketplace Worker v${NEW_VERSION}\""
