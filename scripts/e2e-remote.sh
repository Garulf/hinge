#!/usr/bin/env bash
# Runs the Playwright e2e suite on a remote host with a real GPU and copies
# the results back. Usage:
#
#   HINGE_REMOTE=<ssh alias> scripts/e2e-remote.sh [playwright args]
#
# The remote host must be reachable over the alias's ssh config (see
# the ssh config). Node is expected either on the
# remote PATH already, or installed at ~/.local/share/node-v22 (that path is
# prepended to PATH automatically when present).
#
# On a Darwin remote, the actual `playwright test` step (the only part that
# opens windows) runs as a LaunchAgent bootstrapped into the logged-in
# user's gui/<uid> session instead of being spawned directly from the ssh
# shell: a plain ssh session lives in a different audit session than the
# console login, so Electron can't reach the WindowServer from it, and
# `launchctl asuser` (the usual fix) needs root, which this host doesn't
# grant. Launching through a self-owned LaunchAgent needs no privilege and
# puts the process in the right session. `npm ci`/`npm run build` don't need
# a display, so they still run directly over ssh. On a Linux remote,
# xvfb-run wraps the test step instead.
set -euo pipefail

if [[ -z "${HINGE_REMOTE:-}" ]]; then
  echo "usage: HINGE_REMOTE=<ssh alias> $0 [playwright args]" >&2
  exit 2
fi

remote="$HINGE_REMOTE"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_dir="hinge-e2e"
timeout="${HINGE_E2E_REMOTE_TIMEOUT:-900}"

args_quoted=""
for a in "$@"; do
  args_quoted="$args_quoted $(printf '%q' "$a")"
done

echo "==> syncing $repo_root to $remote:$remote_dir/" >&2
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude 'vendor' \
  --exclude 'dist' \
  --exclude 'out' \
  --exclude 'test-results' \
  --exclude '.git' \
  --exclude '.cache/hinge' \
  --exclude '.worktrees' \
  "$repo_root/" "$remote:$remote_dir/"

echo "==> detecting remote OS" >&2
remote_os="$(ssh "$remote" uname -s)"

echo "==> installing deps (if needed) and building on $remote" >&2
ssh "$remote" bash -s <<REMOTE_EOF
set -euo pipefail
cd "\$HOME/$remote_dir"
node_bin="\$HOME/.local/share/node-v22/bin"
if [ -d "\$node_bin" ]; then
  export PATH="\$node_bin:\$PATH"
fi

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "\$1" | awk '{print \$1}'
  else
    shasum -a 256 "\$1" | awk '{print \$1}'
  fi
}

new_hash="\$(hash_of package-lock.json)"
old_hash=""
[ -f .npm-ci-lockhash ] && old_hash="\$(cat .npm-ci-lockhash)"
if [ "\$new_hash" != "\$old_hash" ]; then
  echo "package-lock.json changed, running npm ci" >&2
  npm ci
  echo "\$new_hash" > .npm-ci-lockhash
else
  echo "package-lock.json unchanged, skipping npm ci" >&2
fi

npm run build
REMOTE_EOF

status=0
if [[ "$remote_os" == "Darwin" ]]; then
  echo "==> running playwright test on $remote via a LaunchAgent (real display)" >&2
  label="net.garulf.hinge-e2e-$$"

  ssh "$remote" bash -s <<REMOTE_EOF
set -euo pipefail
cd "\$HOME/$remote_dir"
cat > .e2e-run.sh <<'RUNNER'
#!/bin/bash
set -uo pipefail
cd "\$HOME/$remote_dir"
node_bin="\$HOME/.local/share/node-v22/bin"
if [ -d "\$node_bin" ]; then
  export PATH="\$node_bin:\$PATH"
fi
export HINGE_E2E_REAL_GPU=1
npx playwright test$args_quoted
echo \$? > .e2e-run.status
RUNNER
chmod +x .e2e-run.sh

mkdir -p "\$HOME/Library/LaunchAgents"
cat > "\$HOME/Library/LaunchAgents/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>\$HOME/$remote_dir/.e2e-run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>\$HOME/$remote_dir</string>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>\$HOME/$remote_dir/.e2e-run.log</string>
  <key>StandardErrorPath</key><string>\$HOME/$remote_dir/.e2e-run.log</string>
</dict>
</plist>
PLIST

rm -f .e2e-run.status .e2e-run.log
uid_n="\$(id -u)"
launchctl bootout "gui/\$uid_n/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/\$uid_n" "\$HOME/Library/LaunchAgents/$label.plist"
launchctl kickstart -k "gui/\$uid_n/$label"
REMOTE_EOF

  echo "==> waiting for the remote run to finish (timeout ${timeout}s)" >&2
  output="$(ssh "$remote" bash -s <<REMOTE_EOF
set -uo pipefail
cd "\$HOME/$remote_dir"
deadline=$timeout
elapsed=0
while [ ! -f .e2e-run.status ]; do
  if [ "\$elapsed" -ge "\$deadline" ]; then
    echo "-1" > .e2e-run.status
    echo "timed out waiting for the remote e2e run" >&2
    break
  fi
  sleep 2
  elapsed=\$((elapsed + 2))
done
cat .e2e-run.log 2>/dev/null || true
printf 'HINGE_E2E_EXIT:%s\n' "\$(cat .e2e-run.status)"
REMOTE_EOF
)"
  printf '%s\n' "$output"
  status="$(printf '%s\n' "$output" | grep -o 'HINGE_E2E_EXIT:-\?[0-9]*' | tail -1 | cut -d: -f2)"

  ssh "$remote" bash -s <<REMOTE_EOF
uid_n="\$(id -u)"
launchctl bootout "gui/\$uid_n/$label" >/dev/null 2>&1 || true
rm -f "\$HOME/Library/LaunchAgents/$label.plist"
REMOTE_EOF
else
  echo "==> running playwright test on $remote under xvfb" >&2
  set +e
  ssh "$remote" bash -s <<REMOTE_EOF
set -euo pipefail
cd "\$HOME/$remote_dir"
node_bin="\$HOME/.local/share/node-v22/bin"
if [ -d "\$node_bin" ]; then
  export PATH="\$node_bin:\$PATH"
fi
export HINGE_E2E_REAL_GPU=1
xvfb-run -a npx playwright test$args_quoted
REMOTE_EOF
  status=$?
  set -e
fi

echo "==> copying test-results back" >&2
local_results="$repo_root/test-results/remote-${remote}"
mkdir -p "$local_results"
rsync -az "$remote:$remote_dir/test-results/" "$local_results/" 2>/dev/null || echo "no remote test-results to copy" >&2

exit "${status:-1}"
