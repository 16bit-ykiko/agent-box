#!/bin/bash
# Installed as ~/.box/job. Runs `box run` commands detached from the ssh session, so a dropped
# tunnel only interrupts the output, and kills them with everything they started.
#   job start DIR   run DIR/cmd in ~/src; DIR/log gets its output, DIR/pid its pid (printed),
#                   DIR/exit its status
#   job kill DIR    kill that command and its children
#   job untunnel    stop the quick tunnel once the box has moved to a named one
set -uo pipefail
windows() { [[ $(uname -s) == MINGW* || $(uname -s) == MSYS* ]]; }

case $1 in
  start)
    d=$2
    cat > "$d/run.sh" <<'RUN'
d=$(dirname "$0")
echo $$ > "$d/pid"
[[ -f ~/.box/env ]] && . ~/.box/env
cd -P ~/src 2>/dev/null || cd ~
bash "$d/cmd" > "$d/log" 2>&1 < /dev/null
echo $? > "$d/exit"
RUN
    if windows; then
      # Win32-OpenSSH ends every process of a session with the session; WMI starts it outside.
      powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
        -File "$(cygpath -w ~/.box/spawn.ps1)" "$(cygpath -w "$d/run.sh")" || exit 1
    else
      # A session of its own, so `kill` can take the whole group; macOS has no setsid.
      if command -v setsid >/dev/null; then detach=(setsid); else detach=(perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' --); fi
      "${detach[@]}" nohup bash "$d/run.sh" > /dev/null 2>&1 < /dev/null &
    fi
    for _ in $(seq 100); do [[ -s $d/pid ]] && break; sleep 0.1; done
    cat "$d/pid"
    ;;
  kill)
    pid=$(cat "$2/pid")
    if windows; then
      # Native children (cl.exe, ninja.exe) never see msys signals, and msys forks leave no
      # Windows parent links, so every Windows process of the msys group gets taskkill /T.
      for w in $(ps | sed -E 's/^[ISO] / /' | awk -v g="$pid" '$3 == g { print $4 }'); do
        taskkill //T //F //PID "$w" > /dev/null 2>&1
      done
    else
      kill -TERM -- "-$pid" 2>/dev/null
    fi
    true
    ;;
  untunnel)
    if windows; then taskkill //F //PID "$(cat ~/.box/quick.pid)" > /dev/null 2>&1; else kill "$(cat ~/.box/quick.pid)" 2>/dev/null; fi
    true
    ;;
  *)
    echo "usage: job start|kill DIR | job untunnel" >&2
    exit 2
    ;;
esac
