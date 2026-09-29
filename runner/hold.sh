#!/bin/bash
set -uo pipefail
[[ $MINUTES =~ ^[0-9]+$ && $IDLE_MINUTES =~ ^[0-9]+$ ]] || { echo "minutes must be whole numbers"; exit 1; }

box=~/.box
stop() {
  echo "$1"
  kill $(cat "$box"/*.pid 2>/dev/null) 2>/dev/null
  exit 0
}
touch "$box/active"
end=$((SECONDS + MINUTES * 60))
while ((SECONDS < end)); do
  [[ -e $box/stop ]] && stop "stopped"
  # An ssh session or a `box run` job still running counts as activity.
  pgrep -u "$USER" -f "^sshd(-session)?: $USER|\.box/jobs/" >/dev/null && touch "$box/active"
  (($(date +%s) - $(stat -c %Y "$box/active") > IDLE_MINUTES * 60)) && stop "idle for $IDLE_MINUTES minutes"
  sleep 5
done
stop "reached $MINUTES minutes"
