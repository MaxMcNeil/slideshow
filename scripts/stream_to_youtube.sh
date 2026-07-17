#!/usr/bin/env bash
# Diffuse output/slideshow.mp4 en boucle infinie vers YouTube Live.
# Usage: ./stream_to_youtube.sh rtmp://a.rtmp.youtube.com/live2 TA_CLE_STREAM

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIDEO="$ROOT/output/slideshow.mp4"

RTMP_URL="${1:-}"
STREAM_KEY="${2:-}"

if [[ -z "$RTMP_URL" || -z "$STREAM_KEY" ]]; then
  echo "Usage: $0 <rtmp_url> <stream_key>"
  echo "Ex:    $0 rtmp://a.rtmp.youtube.com/live2 xxxx-xxxx-xxxx-xxxx"
  exit 1
fi

if [[ ! -f "$VIDEO" ]]; then
  echo "Fichier introuvable: $VIDEO. Lance d'abord generate_slideshow.py"
  exit 1
fi

ffmpeg -re -stream_loop -1 -i "$VIDEO" \
  -c:v copy -c:a copy \
  -f flv "${RTMP_URL}/${STREAM_KEY}"
