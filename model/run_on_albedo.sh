#!/usr/bin/env bash
# Usage: model/run_on_albedo.sh <script.py> [args...]
# Runs a model/ script in headless Blender on albedo. Local paths given with
# --out <file> or --outdir <dir> are written remotely and copied back; a local
# file given with --glb <file> is uploaded first. Exit code is Blender's.
set -euo pipefail

model_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
host="${HINGE_BLENDER_HOST:-albedo}"
blender_exe='"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"'
remote_dir="hinge-model"

ssh_run() {
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$@"
}

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <script.py> [args...]" >&2
    exit 2
fi
script="$(basename "$1")"
shift

remote_args=()
fetches=()
uploads=()
while (($#)); do
    case "$1" in
        --out | --outdir)
            name="$(basename "$2")"
            remote_args+=("$1" "out\\$name")
            fetches+=("$1|$name|$2")
            shift 2
            ;;
        --glb)
            name="$(basename "$2")"
            remote_args+=("$1" "in\\$name")
            uploads+=("$2")
            shift 2
            ;;
        *)
            remote_args+=("$1")
            shift
            ;;
    esac
done

ssh_run "$host" "cd /d %USERPROFILE% && (if not exist $remote_dir mkdir $remote_dir) && cd $remote_dir && (if not exist out mkdir out) && (if not exist in mkdir in)" >/dev/null
scp -q "$model_dir"/*.py "$model_dir"/colorways.json "$host:$remote_dir/"
for local_file in "${uploads[@]}"; do
    scp -q "$local_file" "$host:$remote_dir/in/"
done

clear_outputs=""
for entry in "${fetches[@]}"; do
    IFS='|' read -r flag name _ <<<"$entry"
    if [[ $flag == --outdir ]]; then
        clear_outputs+="(if exist out\\$name rmdir /s /q out\\$name) && "
    else
        clear_outputs+="(if exist out\\$name del /q out\\$name) && "
    fi
done

set +e
ssh_run "$host" "cd /d %USERPROFILE%\\$remote_dir && ${clear_outputs}$blender_exe -b --factory-startup --python-exit-code 1 --python $script -- ${remote_args[*]}"
status=$?
set -e

if [[ $status -eq 0 ]]; then
    for entry in "${fetches[@]}"; do
        IFS='|' read -r flag name local_path <<<"$entry"
        mkdir -p "$(dirname "$local_path")"
        if [[ $flag == --outdir ]]; then
            rm -rf "$local_path"
            scp -q -r "$host:$remote_dir/out/$name" "$(dirname "$local_path")/"
        else
            scp -q "$host:$remote_dir/out/$name" "$local_path"
        fi
    done
fi
exit $status
