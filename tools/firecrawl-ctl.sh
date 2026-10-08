#!/usr/bin/env bash
# firecrawl-ctl.sh — on-demand lifecycle control for the Firecrawl docker stack.
#
# Firecrawl has no native idle-shutdown: its worker fleet (api, searxng,
# rabbitmq, redis, nuq-postgres, playwright) is always resident (~1.3 GB RAM)
# whether or not anything is scraping. On a 4-core/16 GB box that idle cost is
# what tips the machine into swap-thrash. This wrapper makes Firecrawl
# start-on-demand and stop-when-idle.
#
# Subcommands:
#   up        Start the stack (idempotent) and block until /v1 health responds.
#   ensure    Same as `up` but a no-op (fast) if already healthy. Call this
#             before any web_search/web_extract.
#   down      Stop the stack (containers preserved for fast restart).
#   status    Print running/stopped + health.
#   idle-check  Used by the systemd timer: stop the stack after N consecutive
#               idle samples (see IDLE_STOP_AFTER).
#
# Env overrides:
#   FC_DIR              compose project dir (default ~/.openclaw/workspace/firecrawl)
#   FC_URL              health base url    (default http://localhost:3002)
#   FC_CPU_IDLE_PCT     api-container CPU% under which a sample counts as idle (default 5)
#   IDLE_STOP_AFTER     consecutive idle samples before stopping (default 2)
set -euo pipefail

FC_DIR="${FC_DIR:-$HOME/.openclaw/workspace/firecrawl}"
FC_URL="${FC_URL:-http://localhost:3002}"
FC_CPU_IDLE_PCT="${FC_CPU_IDLE_PCT:-5}"
IDLE_STOP_AFTER="${IDLE_STOP_AFTER:-2}"
COMPOSE="docker compose -f $FC_DIR/docker-compose.yaml"
STATE="$FC_DIR/.idle-counter"
API_CONTAINER="firecrawl-api-1"

is_healthy() { curl -sf -m 4 "$FC_URL/" >/dev/null 2>&1 || curl -sf -m 4 "$FC_URL/v1/search" -X POST -H 'Content-Type: application/json' -d '{"query":"ping","limit":1}' >/dev/null 2>&1; }
is_running() { docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${API_CONTAINER}$"; }

cmd_up() {
  echo "[firecrawl-ctl] starting stack..."
  $COMPOSE up -d >/dev/null 2>&1
  for i in $(seq 1 60); do is_healthy && { echo "[firecrawl-ctl] healthy after ${i}s"; rm -f "$STATE"; return 0; }; sleep 1; done
  echo "[firecrawl-ctl] WARNING: not healthy after 60s" >&2; return 1
}

cmd_ensure() { if is_running && is_healthy; then exit 0; fi; cmd_up; }

cmd_down() {
  echo "[firecrawl-ctl] stopping stack..."
  $COMPOSE stop >/dev/null 2>&1
  rm -f "$STATE"
  echo "[firecrawl-ctl] stopped."
}

cmd_status() {
  if is_running; then echo "running: yes"; else echo "running: no"; fi
  if is_healthy; then echo "healthy: yes"; else echo "healthy: no"; fi
  [ -f "$STATE" ] && echo "idle-samples: $(cat "$STATE")"
  return 0
}

# Stop after IDLE_STOP_AFTER consecutive idle samples. "Idle" = api container
# CPU below FC_CPU_IDLE_PCT. Resets the counter the moment it sees activity.
cmd_idle_check() {
  is_running || { rm -f "$STATE"; exit 0; }
  local cpu
  cpu=$(docker stats --no-stream --format '{{.CPUPerc}}' "$API_CONTAINER" 2>/dev/null | tr -d '%' || echo 0)
  cpu=${cpu%.*}; cpu=${cpu:-0}
  local n=0; [ -f "$STATE" ] && n=$(cat "$STATE")
  if [ "$cpu" -lt "$FC_CPU_IDLE_PCT" ]; then
    n=$((n+1)); echo "$n" > "$STATE"
    echo "[firecrawl-ctl] idle sample $n/$IDLE_STOP_AFTER (cpu=${cpu}%)"
    if [ "$n" -ge "$IDLE_STOP_AFTER" ]; then cmd_down; fi
  else
    rm -f "$STATE"; echo "[firecrawl-ctl] active (cpu=${cpu}%), counter reset"
  fi
}

case "${1:-status}" in
  up) cmd_up ;;
  ensure) cmd_ensure ;;
  down) cmd_down ;;
  status) cmd_status ;;
  idle-check) cmd_idle_check ;;
  *) echo "usage: $0 {up|ensure|down|status|idle-check}" >&2; exit 2 ;;
esac
