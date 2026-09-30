#!/bin/bash
# Linux, macOS and Windows (Git Bash).
set -uo pipefail
[[ $MINUTES =~ ^[0-9]+$ && $IDLE_MINUTES =~ ^[0-9]+$ ]] || { echo "minutes must be whole numbers"; exit 1; }

box=~/.box
stop() {
  echo "$1"
  kill $(cat "$box"/*.pid 2>/dev/null) 2>/dev/null
  exit 0
}
connected() {
  { ss -tn 2>/dev/null || netstat -an 2>/dev/null; } |
    grep -Eq 'ESTAB.*127\.0\.0\.1:2222([^0-9]|$)|127\.0\.0\.1[.:]2222[^0-9].*ESTAB'
}
job_running() {
  local pid
  for pid in "$box"/jobs/*/pid; do
    [[ -e $pid && ! -e ${pid%pid}exit ]] && kill -0 "$(cat "$pid")" 2>/dev/null && return 0
  done
  return 1
}

# Sessions get the environment a CI step has here: the workflow's env, PATH from setup steps.
for name in $(compgen -e); do
  [[ $name =~ ^(ACTIONS_|INPUT_|STATE_|GITHUB_(TOKEN|OUTPUT|ENV|PATH|STATE|STEP_SUMMARY|ACTION))|TOKEN|SECRET|PASSWORD|^(PUBKEY|MINUTES|IDLE_MINUTES|HOME|PWD|OLDPWD|SHLVL|USER|LOGNAME|SHELL|_)$ ]] ||
    declare -p "$name"
done > "$box/env"
printf '[[ -f ~/.bashrc ]] && . ~/.bashrc\n. ~/.box/env\n' > "$box/bashrc"

touch "$box/active"
end=$((SECONDS + MINUTES * 60))
while ((SECONDS < end)); do
  [[ -e $box/stop ]] && stop "stopped"
  if connected || job_running; then touch "$box/active"; fi
  [[ -n $(find "$box/active" -mmin +"$IDLE_MINUTES") ]] && stop "idle for $IDLE_MINUTES minutes"
  sleep 10
done
stop "reached $MINUTES minutes"
