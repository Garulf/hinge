#!/bin/bash
# Runs entirely on the remote host, invoked by scripts/e2e-remote.sh over
# ssh with real argv (not meant to be run by hand). It builds the app and
# runs the Playwright suite against a real display.
#
# Argv: <launchagent-label> <timeout-seconds> [playwright args...]
#
# On Darwin the test step (the only part that opens windows) runs as a
# LaunchAgent bootstrapped into the logged-in user's gui/<uid> session
# instead of being spawned directly from this ssh session: a plain ssh
# session lives in a different audit session than the console login, so
# Electron can't reach the WindowServer from it, and `launchctl asuser` (the
# usual fix) needs root, which this host doesn't grant. A self-owned
# LaunchAgent needs no privilege and puts the process in the right session.
# On other platforms, xvfb-run wraps the test step instead; this script's
# own exit code passes straight through xvfb-run's, which itself passes
# through the wrapped command's.
set -uo pipefail

label="${1:?missing launchagent label}"
deadline="${2:?missing timeout}"
shift 2

repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_dir" || exit 1

node_bin="$HOME/.local/share/node-v22/bin"
if [ -d "$node_bin" ]; then
  PATH="$node_bin:$PATH"
  export PATH
fi

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Boots out any LaunchAgent left behind by a run that never got to clean up
# after itself (dropped connection, Ctrl-C locally before the trap's remote
# cleanup could run, etc.), and kills any process still running out of this
# checkout from such a run.
sweep_leftovers() {
  if [ "$(uname -s)" = "Darwin" ]; then
    uid_n="$(id -u)"
    for plist in "$HOME"/Library/LaunchAgents/net.garulf.hinge-e2e-*.plist; do
      [ -e "$plist" ] || continue
      base="$(basename "$plist" .plist)"
      launchctl bootout "gui/$uid_n/$base" >/dev/null 2>&1 || true
      rm -f "$plist"
    done
  fi
  pkill -f "$repo_dir/node_modules/electron/dist/Electron.app" >/dev/null 2>&1 || true
  pkill -f "$repo_dir/.e2e-run.sh" >/dev/null 2>&1 || true
  pkill -f "$repo_dir/node_modules/.bin/playwright" >/dev/null 2>&1 || true
}

# One run at a time per host: the sweep below and the LaunchAgent would
# otherwise kill or collide with another checkout's run in progress.
lock_dir="$HOME/.hinge-e2e.lock"
lock_waited=0
until mkdir "$lock_dir" 2>/dev/null; do
  if [ -n "$(find "$lock_dir" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rmdir "$lock_dir" 2>/dev/null || true
    continue
  fi
  if [ "$lock_waited" -ge 1200 ]; then
    echo "another e2e run still holds $lock_dir after 20 minutes" >&2
    exit 1
  fi
  sleep 5
  lock_waited=$((lock_waited + 5))
done
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

sweep_leftovers

new_hash="$(hash_of package-lock.json)"
old_hash=""
[ -f .npm-ci-lockhash ] && old_hash="$(cat .npm-ci-lockhash)"
if [ "$new_hash" != "$old_hash" ]; then
  echo "package-lock.json changed, running npm ci" >&2
  npm ci
  ci_status=$?
  if [ "$ci_status" -ne 0 ]; then
    exit "$ci_status"
  fi
  echo "$new_hash" > .npm-ci-lockhash
else
  echo "package-lock.json unchanged, skipping npm ci" >&2
fi

npm run build
build_status=$?
if [ "$build_status" -ne 0 ]; then
  exit "$build_status"
fi

if [ "$(uname -s)" = "Darwin" ]; then
  playwright_args=""
  for a in "$@"; do
    playwright_args="$playwright_args $(printf '%q' "$a")"
  done

  cat > .e2e-run.sh <<RUNNER
#!/bin/bash
set -uo pipefail
cd "$repo_dir"
export PATH="$PATH"
export HINGE_E2E_REAL_GPU=1
npx playwright test$playwright_args
echo \$? > .e2e-run.status
RUNNER
  chmod +x .e2e-run.sh

  mkdir -p "$HOME/Library/LaunchAgents"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$repo_dir/.e2e-run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$repo_dir</string>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$repo_dir/.e2e-run.log</string>
  <key>StandardErrorPath</key><string>$repo_dir/.e2e-run.log</string>
</dict>
</plist>
PLIST

  rm -f .e2e-run.status .e2e-run.log
  uid_n="$(id -u)"
  launchctl bootout "gui/$uid_n/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid_n" "$plist"
  launchctl kickstart -k "gui/$uid_n/$label"

  elapsed=0
  while [ ! -f .e2e-run.status ]; do
    if [ "$elapsed" -ge "$deadline" ]; then
      echo "timed out waiting for the remote e2e run" >&2
      cat .e2e-run.log 2>/dev/null || true
      launchctl bootout "gui/$uid_n/$label" >/dev/null 2>&1 || true
      rm -f "$plist"
      exit 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  cat .e2e-run.log 2>/dev/null || true
  status="$(cat .e2e-run.status)"

  launchctl bootout "gui/$uid_n/$label" >/dev/null 2>&1 || true
  rm -f "$plist"
  exit "$status"
else
  export HINGE_E2E_REAL_GPU=1
  if command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run -a npx playwright test "$@"
  else
    npx playwright test "$@"
  fi
  exit $?
fi
