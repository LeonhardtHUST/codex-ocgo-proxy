#!/usr/bin/env bash
#
# Fork-only smoke runner for the unpacked Linux build.
#
# The upstream smoke script only launches the AppImage. OCGO smoke tests run
# the unpacked tree instead so the CI-only smoke config overlay (applied after
# packaging) is what actually starts, while the shipped AppImage keeps the
# real config. The checks match the upstream script: wait for the server port
# line, probe /health, and fail loudly on packaging breakage.
#
# Required env:
#   RELEASE_DIR  path to packages/electron/release-ocgo
# Optional env:
#   SMOKE_LOG    log file path
#   SMOKE_BINARY binary name inside linux-unpacked (default
#                codex-proxy-ocgo-unofficial)

set -uo pipefail

LOG="${SMOKE_LOG:-$(mktemp)}"
TIMEOUT_SECS="${SMOKE_TIMEOUT:-90}"
BIN="${RELEASE_DIR:-}/linux-unpacked/${SMOKE_BINARY:-codex-proxy-ocgo-unofficial}"

die() {
  echo "::error::$*"
  echo "─── smoke log ───"
  [ -f "$LOG" ] && cat "$LOG" || echo "(no log captured)"
  exit 1
}

[ -n "${RELEASE_DIR:-}" ] || die "RELEASE_DIR not set"
if [ ! -x "$BIN" ]; then
  # executableName in electron-builder should pin the name; fall back to the
  # largest executable in the unpacked tree if a packer version names it
  # differently, so the smoke test still exercises the real payload.
  BIN="$(find "$RELEASE_DIR/linux-unpacked" -maxdepth 1 -type f -executable -size +5M \
    ! -name 'chrome_crashpad_handler' | head -1 || true)"
fi
[ -n "${BIN:-}" ] && [ -x "$BIN" ] || die "Linux binary not found or not executable under $RELEASE_DIR/linux-unpacked"

APP_PID=""
cleanup() {
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "Stopping app group (pid=$APP_PID)"
    # setsid put the whole xvfb-run/app group under $APP_PID; never match by
    # name so no unrelated process on the runner can be hit.
    kill -- "-$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
    sleep 2
    kill -9 -- "-$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Launching: $BIN"
echo "Log: $LOG"
echo "Timeout: ${TIMEOUT_SECS}s"

setsid xvfb-run -a --server-args="-screen 0 1024x768x24" "$BIN" --no-sandbox >"$LOG" 2>&1 &
APP_PID=$!

PORT=""
DEADLINE=$(( $(date +%s) + TIMEOUT_SECS ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$LOG" ]; then
    PORT=$(grep -oE 'Server started on port [0-9]+' "$LOG" 2>/dev/null | grep -oE '[0-9]+' | tail -1 || true)
    [ -n "$PORT" ] && break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    die "App process exited before starting the server (pid=$APP_PID)"
  fi
  sleep 1
done
[ -n "$PORT" ] || die "App did not log 'Server started on port N' within ${TIMEOUT_SECS}s"

echo "App reports server on port $PORT"

HEALTH_OK=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 1
done
[ "$HEALTH_OK" = "true" ] || die "Health probe failed: GET http://127.0.0.1:$PORT/health (gave up after 30s)"

echo "✓ OCGO smoke OK on Linux (unpacked build)"
