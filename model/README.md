# model

Blender scripts that build the Galaxy Z Fold 7 model and export `fold7.glb`.

Blender 5.2 runs on albedo, so the scripts are run through `run_on_albedo.sh`,
which copies `model/*.py` and `colorways.json` to `%USERPROFILE%\hinge-model\`,
runs Blender headless and copies `--out` / `--outdir` results back.

```sh
model/run_on_albedo.sh build_fold7.py --out model/out/fold7.glb
model/run_on_albedo.sh build_fold7.py --pose-test
uv run --with pygltflib model/check_glb.py model/out/fold7.glb
```

All dimensions live in `fold7_params.py` (millimetres, glTF frame). `SpecDimensions`
are published figures; `ImageEstimates` are measured from product images.

`render_views.py` imports an exported glb into an empty scene and renders the
comparison views with Cycles; `compare_views.sh` puts each render beside the
matching crop of an official product image (kept outside this repo).

```sh
model/run_on_albedo.sh render_views.py --glb model/out/fold7.glb --outdir model/out/renders --colorway blue-shadow
model/compare_views.sh <reference_dir> model/out/renders model/out/compare
```

## What the app can rely on

Frame: metres, +Y up (long axis), +X right, +Z toward the viewer of the inner
screen. The file is in the rest pose, fully open (fold angle 180 degrees).

- `Root` > `FixedHalf` (camera half, X > 0, never moves), `Root` > `Hinge` > `CoverHalf`
  (X < 0 when open, carries `CoverScreen`), `Root` > `Rig` (bones `bone_fixed`, `bone_cover`).
  The skinned `InnerScreen` and `HingeFill` are children of `FixedHalf`; their
  skin joints are `bone_fixed` (child of `Rig`) and `bone_cover` (child of `bone_fixed`).
  `check_glb.py` asserts these parents. Blender's glTF importer moves skinned
  meshes under the armature on import, so a re-imported scene differs from the file.
- Fold angle `a` (0 closed, 100 half open, 180 open): set the full rotation of
  both `Hinge` and `bone_cover` to a rotation of `-a` about +Y, for example
  `q.setFromAxisAngle(Y, -a)` on each. Both nodes sit on the hinge axis and share
  the same rest transform, so the same quaternion drives the rigid cover half and
  the skinned crease.
- `InnerScreen` is one skinned mesh; its 6 mm crease band bends between the
  bones and dips `crease_depth_mm` (0.1 mm) into a shallow groove along the
  hinge line, deepest on the line. UVs are projected straight down, so the
  groove leaves u linear in X. `HingeFill` is a small skinned strip under the crease in the spine
  material; it closes the hinge slot when the phone is shut, so keep it visible
  even while `InnerScreen` is hidden.
- Screen UVs (`screen_inner`, `screen_cover` primitives) span 0..1 over the
  active area with v increasing upward (bottom-left origin, like a three.js
  texture with `flipY = true`). `InnerScreen` u increases toward +X. `CoverScreen`
  u increases toward -X in the rest pose, which is left to right as seen by
  someone looking at the cover screen of the closed phone. Border primitives
  (`screen_border`) carry UVs outside 0..1.
- Screen node extras: `punchHole` = `[u, v, radius in u]`, `cornerRadiusUv` =
  `[ru, rv]`, `pixelSize` = `[w, h]`.
- `colorways.json` holds per-colourway base colour, metallic and roughness for
  `frame`, `back_glass`, `hinge_spine`, `camera_island`, `button` and
  `antenna_band`, applied by material name. The glb carries `jetblack`.
