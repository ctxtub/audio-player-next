#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/push-ghcr.sh <tag> <github-username> [image-name] [platforms]
# Builds the Dockerfile with Buildx, produces a multi-arch image manifest, and pushes it to GHCR.
#   tag:            defaults to "latest"
#   github-username defaults to "ctxtub"
#   image-name      defaults to "audio-player-next"
#   platforms       defaults to "linux/amd64,linux/arm64" for a universal image

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found. Install Docker Desktop or Docker CLI first." >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is unavailable. Please enable Buildx (Docker 19.03+) before running this script." >&2
  exit 1
fi

TAG="${1:-latest}"
USERNAME="${2:-ctxtub}"
IMAGE_NAME="${3:-audio-player-next}"
PLATFORMS="${4:-linux/amd64}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GHCR_IMAGE="ghcr.io/${USERNAME}/${IMAGE_NAME}:${TAG}"
LOCAL_IMAGE="${IMAGE_NAME}:${TAG}"
BUILDER_NAME="${BUILDER_NAME:-audio-player-next-builder}"

echo "Ensuring Buildx builder \"${BUILDER_NAME}\" exists..."
if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
  docker buildx create --name "${BUILDER_NAME}" --driver docker-container >/dev/null
fi
docker buildx use "${BUILDER_NAME}"
docker buildx inspect --bootstrap "${BUILDER_NAME}" >/dev/null

echo "Building ${GHCR_IMAGE} for platforms: ${PLATFORMS}"
docker buildx build \
  --builder "${BUILDER_NAME}" \
  --platform "${PLATFORMS}" \
  -t "${GHCR_IMAGE}" \
  -f "${PROJECT_ROOT}/Dockerfile" \
  --provenance=false \
  --sbom=false \
  --push \
  "${PROJECT_ROOT}"

echo "Pushed ${GHCR_IMAGE} to GitHub Container Registry."
echo "Done. Image available at ${GHCR_IMAGE}"
