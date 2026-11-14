#!/usr/bin/env bash
# Build the self-contained Home Assistant add-on release tree.
#
# The canonical server stays in server/ on the main branch. The Supervisor
# builds an add-on from the app's own directory, so this script copies the
# server into that directory in the generated release branch.
set -euo pipefail

OUT="${1:?usage: build-hassio-release.sh <output-dir>}"
REPO_ROOT="$(pwd)"
cd "$REPO_ROOT"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

# Resolve the repository without relying on Git's path translation for
# scripts. A linked worktree's .git file may contain an absolute path
# that is not valid in the shell running this script.
GIT_DIR="$REPO_ROOT/.git"
if [ ! -d "$GIT_DIR" ]; then
  GIT_DIR="$(sed -n 's/^gitdir: //p' "$GIT_DIR" | tr -d '\r')"
  GIT_DIR="$(printf '%s' "$GIT_DIR" | sed -E 's#^([A-Za-z]):/#/mnt/\L\1/#')"
fi
if [ -f "$GIT_DIR/commondir" ]; then
  COMMON_RELATIVE="$(cat "$GIT_DIR/commondir" | tr -d '\r')"
  if [[ "$COMMON_RELATIVE" = /* ]]; then
    GIT_COMMON_DIR="$COMMON_RELATIVE"
  else
    GIT_COMMON_DIR="$(cd "$GIT_DIR/$COMMON_RELATIVE" && pwd -P)"
  fi
else
  GIT_COMMON_DIR="$GIT_DIR"
fi

APP_DIR="$OUT/paperloom"
rm -rf "$OUT"
mkdir -p "$APP_DIR/rootfs"

cp repository.yaml "$OUT/repository.yaml"

# The generated app is built on the Home Assistant device. An image key
# would make the Supervisor pull from a registry instead.
sed '/^[[:space:]]*image[[:space:]]*:/d' hassio/config.yaml > "$APP_DIR/config.yaml"
if grep -qE '^[[:space:]]*image[[:space:]]*:' "$APP_DIR/config.yaml"; then
  echo "error: an image key survived into the generated config.yaml" >&2
  exit 1
fi

cp hassio/Dockerfile "$APP_DIR/Dockerfile"
cp hassio/rootfs/run.sh "$APP_DIR/rootfs/run.sh"

# Copy only tracked server files. This excludes node_modules and build output.
git --git-dir="$GIT_COMMON_DIR" archive --format=tar HEAD server | tar -x -C "$APP_DIR"

# Git's object store normally contains LF text. Normalize it anyway so a
# CRLF checkout can never produce a broken shell entrypoint.
find "$APP_DIR" -type f -print0 | xargs -0 -r sed -i 's/\r$//'
chmod +x "$APP_DIR/rootfs/run.sh"

echo "release tree written to $OUT"
