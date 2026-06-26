#!/usr/bin/env bash
set -euo pipefail
# Usage: scripts/shot.sh <out.png> [hash] [port]   (run from repo root)
#
# Builds the app, serves `vite preview` on a self-contained server (killed on
# exit), and writes a headless screenshot. Notes that bit us before:
#  - vite preview binds IPv6 [::1]; hit localhost, not 127.0.0.1.
#  - the server is this script's own child + trap-killed, so it never signals
#    the parent shell (avoids the exit-144 you get from `pkill`/stray `&` jobs).
#  - pass [hash] to capture a state behind interaction, e.g. a node selection or
#    an open modal seeded from location.hash.
out="${1:?usage: shot.sh <out.png> [hash] [port]}"; hash="${2:-}"; port="${3:-4399}"
npm run build >/dev/null
node node_modules/vite/bin/vite.js preview --port "$port" --strictPort >/tmp/shot-preview.log 2>&1 &
pid=$!; trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 15); do curl -fsS -o /dev/null "http://localhost:$port/" && break; sleep 1; done
chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1500,1000 --virtual-time-budget=9000 \
  --screenshot="$out" "http://localhost:$port/${hash:+#$hash}"
echo "wrote $out"
