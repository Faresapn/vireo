#!/usr/bin/env bash
# Create the Google Drive folder tree for one persona/niche.
# Usage: ./drive_init_niche.sh <niche-slug>
# Idempotent: rclone mkdir does nothing if folder already exists.
set -euo pipefail

REMOTE="gdrive:"
BASE="HiggsfieldStudio"
SLUG="${1:-}"

if [ -z "$SLUG" ]; then
  echo "Usage: $0 <niche-slug>" >&2
  exit 2
fi

# base + per-niche subfolders
for sub in \
  "$BASE" \
  "$BASE/$SLUG" \
  "$BASE/$SLUG/characters" \
  "$BASE/$SLUG/references" \
  "$BASE/$SLUG/output" \
  "$BASE/$SLUG/output/480p" \
  "$BASE/$SLUG/output/1080p"
do
  rclone mkdir "${REMOTE}${sub}" 2>/dev/null
done

echo "OK: ${REMOTE}${BASE}/${SLUG}/{characters,references,output/{480p,1080p}}"
