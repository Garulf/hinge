#!/usr/bin/env bash
# Usage: model/compare_views.sh <reference_dir> <render_dir> <out_dir>
# Builds compare-<view>.png: the matching crop of an official product image on
# the left, the render on the right, both scaled to the render's height.
set -euo pipefail

ref_dir="$1"
render_dir="$2"
out_dir="$3"
ffmpeg_bin="${FFMPEG:-ffmpeg}"
mkdir -p "$out_dir"

declare -A reference=(
    [front-open]="samsung-galaxy-z-fold7-1.jpg|crop=iw:ih:0:0"
    [back-open]="samsung-galaxy-z-fold7-2.jpg|crop=iw:ih:0:0"
    [front-closed]="samsung-galaxy-z-fold7-2.jpg|crop=294:650:296:0"
    [side-closed]="samsung-galaxy-z-fold7-5.jpg|crop=710:80:0:0"
    [half-open-100]="samsung-galaxy-z-fold7-3.jpg|crop=300:556:0:0"
    [crease-zoom]="samsung-galaxy-z-fold7-1.jpg|crop=153:160:217:0"
)

for view in "${!reference[@]}"; do
    render="$render_dir/$view.png"
    [[ -f $render ]] || continue
    IFS='|' read -r image crop <<<"${reference[$view]}"
    height=$({ "$ffmpeg_bin" -i "$render" 2>&1 || true; } | sed -n 's/.*, \([0-9]\+\)x\([0-9]\+\).*/\2/p' | head -1)
    "$ffmpeg_bin" -loglevel error -y -i "$ref_dir/$image" -i "$render" -filter_complex \
        "[0:v]$crop,scale=-2:$height:flags=lanczos,format=rgb24[ref];[1:v]format=rgb24[img];[ref][img]hstack=inputs=2" \
        "$out_dir/compare-$view.png"
    echo "wrote $out_dir/compare-$view.png"
done
