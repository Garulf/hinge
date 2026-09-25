#!/usr/bin/env bash
# Forwards a local adb port to a remote host's adb server over ssh, so the
# phone attached to that host's adb server (over USB or wireless debugging)
# is reachable from here without running a second adb server locally.
#
#   HINGE_ADB_REMOTE=<ssh alias> scripts/adb-remote.sh start
#   HINGE_ADB_REMOTE=<ssh alias> scripts/adb-remote.sh status
#   HINGE_ADB_REMOTE=<ssh alias> scripts/adb-remote.sh stop
#
# start: opens a background `ssh -L 127.0.0.1:15037:127.0.0.1:5037` to the
#   remote host, tracked by a control socket and pid file under the
#   worktree's .cache/hinge/ dir (or /tmp if that isn't writable).
# status: runs `adb -H 127.0.0.1 -P 15037 devices` through the tunnel. An
#   empty device list is a healthy result if nothing is plugged into the
#   remote host right now; it only means the tunnel and the remote adb
#   server both answered.
# stop: closes the tunnel via the control socket. Never touches the remote
#   adb server itself (no `adb kill-server`/`start-server` anywhere).
set -euo pipefail

usage() {
  echo "usage: HINGE_ADB_REMOTE=<ssh alias> $0 start|stop|status" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
action="$1"

if [[ -z "${HINGE_ADB_REMOTE:-}" ]]; then
  echo "usage: HINGE_ADB_REMOTE=<ssh alias> $0 start|stop|status" >&2
  exit 2
fi

remote="$HINGE_ADB_REMOTE"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

state_dir="$repo_root/.cache/hinge"
if ! mkdir -p "$state_dir" 2>/dev/null || [[ ! -w "$state_dir" ]]; then
  state_dir="/tmp/hinge-adb-remote-$(id -u)"
  mkdir -p "$state_dir"
fi

safe_remote="${remote//[^A-Za-z0-9_.-]/_}"
ctrl_socket="$state_dir/adb-tunnel-${safe_remote}.sock"
pid_file="$state_dir/adb-tunnel-${safe_remote}.pid"

local_host=127.0.0.1
local_port=15037
remote_host=127.0.0.1
remote_port=5037

tunnel_running() {
  [[ -S "$ctrl_socket" ]] && ssh -S "$ctrl_socket" -O check "$remote" >/dev/null 2>&1
}

case "$action" in
  start)
    if tunnel_running; then
      echo "adb tunnel to $remote already running (127.0.0.1:$local_port)" >&2
      exit 0
    fi
    rm -f "$ctrl_socket" "$pid_file"
    ssh -f -N -M -S "$ctrl_socket" \
      -o ExitOnForwardFailure=yes \
      -L "${local_host}:${local_port}:${remote_host}:${remote_port}" \
      "$remote"
    # -M creates the control socket synchronously before ssh backgrounds, so
    # a running master and the socket file both exist by the time -f returns.
    if ! tunnel_running; then
      echo "failed to start adb tunnel to $remote" >&2
      exit 1
    fi
    # ssh -f doesn't hand back the backgrounded pid; ask the master for it.
    ssh -S "$ctrl_socket" -O check "$remote" 2>&1 | grep -o 'pid=[0-9]*' | cut -d= -f2 >"$pid_file" || true
    echo "adb tunnel to $remote started: 127.0.0.1:$local_port -> $remote:127.0.0.1:$remote_port" >&2
    ;;

  status)
    if ! tunnel_running; then
      echo "adb tunnel to $remote is not running" >&2
      exit 1
    fi
    exec adb -H "$local_host" -P "$local_port" devices
    ;;

  stop)
    if ! tunnel_running; then
      echo "adb tunnel to $remote is not running" >&2
      rm -f "$ctrl_socket" "$pid_file"
      exit 0
    fi
    ssh -S "$ctrl_socket" -O exit "$remote" >/dev/null 2>&1 || true
    rm -f "$ctrl_socket" "$pid_file"
    echo "adb tunnel to $remote stopped" >&2
    ;;

  *)
    usage
    ;;
esac
