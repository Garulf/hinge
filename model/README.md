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
