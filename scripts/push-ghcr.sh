#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/push-ghcr.sh [tag] [github-username] [image-name] [platforms]
# Builds the Dockerfile with Buildx, tags immutable sha-<shortSHA> and latest, and pushes to GHCR.
#   tag:             tag name (defaults to "latest", or github ref tag if in GHA)
#   github-username: defaults to $GITHUB_REPOSITORY_OWNER or "ctxtub"
#   image-name:      defaults to "audio-player-next"
#   platforms:       defaults to "linux/amd64"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found. Install Docker Desktop or Docker CLI first." >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is unavailable. Please enable Buildx (Docker 19.03+) before running this script." >&2
  exit 1
fi

TAG_INPUT="${1:-}"
USERNAME="${2:-${GITHUB_REPOSITORY_OWNER:-ctxtub}}"
IMAGE_NAME="${3:-audio-player-next}"
PLATFORMS="${4:-linux/amd64}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Optional non-interactive login for local/manual usage without logging secrets
if [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "${GHCR_TOKEN}" | docker login ghcr.io -u "${USERNAME}" --password-stdin >/dev/null 2>&1
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  printf '%s' "${GITHUB_TOKEN}" | docker login ghcr.io -u "${USERNAME}" --password-stdin >/dev/null 2>&1
fi

# Resolve primary tag: explicit argument > GHA tag ref > "latest"
if [ -n "${TAG_INPUT}" ]; then
  PRIMARY_TAG="${TAG_INPUT}"
elif [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
  PRIMARY_TAG="${GITHUB_REF_NAME}"
else
  PRIMARY_TAG="latest"
fi

# Resolve git commit SHA for immutable sha-<shortSHA> tag
GIT_SHA="${GITHUB_SHA:-$(git -C "${PROJECT_ROOT}" rev-parse HEAD 2>/dev/null || true)}"
SHORT_SHA=""
if [ -n "${GIT_SHA}" ]; then
  SHORT_SHA="${GIT_SHA:0:7}"
fi

# Build array of unique tags to publish: always include latest and sha-<shortSHA>
declare -A SEEN_TAGS=()
TAG_NAMES=()

add_tag() {
  local t="$1"
  if [ -n "$t" ] && [ -z "${SEEN_TAGS[$t]:-}" ]; then
    SEEN_TAGS[$t]=1
    TAG_NAMES+=("$t")
  fi
}

# 1. Primary requested tag (e.g. latest, v1.0.0)
add_tag "${PRIMARY_TAG}"

# 2. Always publish latest
add_tag "latest"

# 3. Always publish immutable sha-<shortSHA> if git SHA is available
if [ -n "${SHORT_SHA}" ]; then
  add_tag "sha-${SHORT_SHA}"
fi

BUILDER_NAME="${BUILDER_NAME:-audio-player-next-builder}"

echo "Ensuring Buildx builder \"${BUILDER_NAME}\" exists..."
if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
  docker buildx create --name "${BUILDER_NAME}" --driver docker-container >/dev/null
fi
docker buildx use "${BUILDER_NAME}"
docker buildx inspect --bootstrap "${BUILDER_NAME}" >/dev/null

BUILD_TAG_ARGS=()
echo "Configured image tags:"
for t in "${TAG_NAMES[@]}"; do
  FULL_IMAGE="ghcr.io/${USERNAME}/${IMAGE_NAME}:${t}"
  echo "  - ${FULL_IMAGE}"
  BUILD_TAG_ARGS+=(-t "${FULL_IMAGE}")
done

BUILD_LABEL_ARGS=()
if [ -n "${GIT_SHA}" ]; then
  BUILD_LABEL_ARGS+=(--label "org.opencontainers.image.revision=${GIT_SHA}")
fi
BUILD_LABEL_ARGS+=(--label "org.opencontainers.image.source=https://github.com/${USERNAME}/${IMAGE_NAME}")

BUILD_EXTRA_ARGS=()
if [ "${PUSH_IMAGE:-true}" = "true" ] || [ "${PUSH_IMAGE:-true}" = "1" ]; then
  BUILD_EXTRA_ARGS+=(--push)
fi

echo "Building images for platforms: ${PLATFORMS}"
docker buildx build \
  --builder "${BUILDER_NAME}" \
  --platform "${PLATFORMS}" \
  "${BUILD_TAG_ARGS[@]}" \
  "${BUILD_LABEL_ARGS[@]}" \
  -f "${PROJECT_ROOT}/Dockerfile" \
  --provenance=false \
  --sbom=false \
  "${BUILD_EXTRA_ARGS[@]}" \
  "${PROJECT_ROOT}"

if [ "${PUSH_IMAGE:-true}" = "true" ] || [ "${PUSH_IMAGE:-true}" = "1" ]; then
  echo "Successfully pushed images to GitHub Container Registry."
else
  echo "Build completed successfully (push skipped via PUSH_IMAGE=false)."
fi
