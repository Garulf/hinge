#!/usr/bin/env bash
# Runs the Playwright e2e suite on a remote host with a real GPU and copies
# the results back. Usage:
#
#   HINGE_REMOTE=<ssh alias> scripts/e2e-remote.sh [playwright args]
#
# The remote host must be reachable non-interactively through its ssh config
# alias (key auth, no prompts). Node is expected either on the remote PATH
# already, or installed at ~/.local/share/node-v22 (that path is prepended to
# PATH automatically when present).
#
# This script only syncs the tree and kicks off scripts/remote/e2e-runner.sh
# over there, with the remaining behaviour (build, LaunchAgent handling on
# Darwin, xvfb-run elsewhere) living in that runner script so nothing here
# has to reconstruct remote shell logic through nested heredocs.
set -euo pipefail

usage() {
  echo "usage: HINGE_REMOTE=<ssh alias> $0 [playwright args]" >&2
  exit 2
}

if [[ -z "${HINGE_REMOTE:-}" ]]; then
  usage
fi

remote="$HINGE_REMOTE"
case "$remote" in
  -*)
    echo "error: HINGE_REMOTE must not start with '-': $remote" >&2
    exit 1
    ;;
esac

timeout="${HINGE_E2E_REMOTE_TIMEOUT:-900}"
case "$timeout" in
  '' | *[!0-9]*)
    echo "error: HINGE_E2E_REMOTE_TIMEOUT must be a non-negative integer: $timeout" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_dir="hinge-e2e"
label="net.garulf.hinge-e2e-$$"

# shellcheck disable=SC2317  # invoked indirectly via trap
cleanup() {
  # Best effort: if the run above never reached its own cleanup (dropped
  # connection, Ctrl-C, a hard failure before the runner's own trap-less
  # cleanup ran), boot out this run's LaunchAgent and remove its plist so it
  # doesn't linger on the remote host.
  ssh -o ConnectTimeout=5 -o BatchMode=yes -- "$remote" \
    "uid_n=\$(id -u); launchctl bootout \"gui/\$uid_n/$label\" >/dev/null 2>&1 || true; rm -f \"\$HOME/Library/LaunchAgents/$label.plist\"" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Hidden directories at the top of the tree (.git, worktrees, editor and
# tool state) are local only; the runner's own state files are kept remotely.
echo "==> syncing $repo_root to $remote:$remote_dir/" >&2
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude 'vendor' \
  --exclude 'dist' \
  --exclude 'out' \
  --exclude 'test-results' \
  --exclude '/.*/' \
  --exclude '.npm-ci-lockhash' \
  --exclude '.e2e-run.*' \
  -- "$repo_root/" "$remote:$remote_dir/"

echo "==> running scripts/remote/e2e-runner.sh on $remote" >&2
remote_cmd="bash $remote_dir/scripts/remote/e2e-runner.sh $(printf '%q' "$label") $(printf '%q' "$timeout")"
for a in "$@"; do
  remote_cmd="$remote_cmd $(printf '%q' "$a")"
done

set +e
ssh -- "$remote" "$remote_cmd"
status=$?
set -e

echo "==> copying test-results back" >&2
local_results="$repo_root/test-results/remote-${remote}"
mkdir -p "$local_results"
rsync -az -- "$remote:$remote_dir/test-results/" "$local_results/" 2>/dev/null || echo "no remote test-results to copy" >&2

exit "$status"
