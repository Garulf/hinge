"""Render comparison views of an exported fold7.glb with Cycles.

Run headless in Blender 5.2:
    blender -b --factory-startup --python render_views.py -- --glb fold7.glb --outdir renders [--views a,b]

The glb is imported into an empty scene, so the renders show what the export
contains. Screen materials are replaced by a grey test pattern that draws the
rounded corners and punch holes from the screens' extras.
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

INNER_SCREEN_HIDDEN_BELOW_DEG = 25.0
REST_FOLD_DEG = 180.0
BACKGROUND_GREY = 0.214
AMBIENT_STRENGTH = 0.35


def mm(value):
    return value * 0.001


VIEWS = {
    "front-closed": {"fold": 0.0, "kind": "ortho", "forward": (0, 1, 0), "up": (0, 0, 1),
                     "centre": (mm(35.8), 0, 0), "fit": (mm(72.0), mm(158.4)), "aspect": 292 / 648},
    "back-open": {"fold": 180.0, "kind": "ortho", "forward": (0, -1, 0), "up": (0, 0, 1),
                  "centre": (0, 0, 0), "fit": (mm(143.2), mm(158.4)), "aspect": 590 / 650},
    "side-closed": {"fold": 0.0, "kind": "ortho", "forward": (1, 0, 0), "up": (0, -1, 0),
                    "centre": (0, mm(-0.3), 0), "fit": (mm(158.4), mm(17.0)), "aspect": 710 / 80},
    "side-bump": {"fold": 0.0, "kind": "ortho", "forward": (1, 0, 0), "up": (0, -1, 0),
                  "centre": (0, mm(-0.9), mm(46.3)), "fit": (mm(67.0), mm(16.7)), "aspect": 300 / 75},
    "front-open": {"fold": 180.0, "kind": "ortho", "forward": (0, 1, 0), "up": (0, 0, 1),
                   "centre": (0, 0, 0), "fit": (mm(143.2), mm(158.4)), "aspect": 589 / 650},
    "half-open-100": {"fold": 100.0, "kind": "persp", "location": (mm(470), mm(-300), mm(50)),
                      "target": (mm(24), mm(-32), mm(0)), "lens": 80.0, "aspect": 300 / 556},
    "crease-zoom": {"fold": 180.0, "kind": "ortho", "forward": (0, 1, 0), "up": (0, 0, 1),
                    "centre": (0, 0, mm(60)), "fit": (mm(143.2 / 4), mm(158.4 / 4)), "aspect": 1.0},
}
INSPECTION_VIEWS = {
    "bottom-edge": {"fold": 0.0, "kind": "persp", "location": (mm(60), mm(-160), mm(-150)),
                    "target": (mm(36), mm(-4.5), mm(-79)), "lens": 90.0, "aspect": 1.6},
    "top-edge": {"fold": 180.0, "kind": "persp", "location": (mm(20), mm(-120), mm(210)),
                 "target": (mm(10), mm(-2), mm(79)), "lens": 90.0, "aspect": 1.6},
    "button-edge": {"fold": 0.0, "kind": "persp", "location": (mm(250), mm(40), mm(60)),
                    "target": (mm(72), mm(-4), mm(20)), "lens": 90.0, "aspect": 1.0},
    "camera-closeup": {"fold": 0.0, "kind": "persp", "location": (mm(160), mm(180), mm(120)),
                       "target": (mm(55), mm(0), mm(47)), "lens": 90.0, "aspect": 1.0},
}
ALL_VIEWS = {**VIEWS, **INSPECTION_VIEWS}
MODEL_DIR = os.path.dirname(os.path.abspath(__file__))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="render_views.py")
    parser.add_argument("--glb", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--views", default=",".join(VIEWS))
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--size", type=int, default=1200)
    parser.add_argument("--colorway", default="jetblack")
    return parser.parse_args(argv)


def setup_cycles(samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    chosen = "CPU"
    for backend in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.refresh_devices()
        gpus = [d for d in prefs.devices if d.type == backend]
        if gpus:
            for device in prefs.devices:
                device.use = device.type == backend
            chosen = backend
            break
    scene.cycles.device = "CPU" if chosen == "CPU" else "GPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "Standard"
    scene.render.film_transparent = False
    print(f"cycles device: {chosen}")


def setup_world():
    world = bpy.data.worlds.new("Studio")
    bpy.context.scene.world = world
    nodes, links = world.node_tree.nodes, world.node_tree.links
    output = nodes["World Output"]
    seen = nodes["Background"]
    seen.inputs["Color"].default_value = (BACKGROUND_GREY, BACKGROUND_GREY, BACKGROUND_GREY, 1.0)
    lighting = nodes.new("ShaderNodeBackground")
    lighting.inputs["Color"].default_value = (BACKGROUND_GREY, BACKGROUND_GREY, BACKGROUND_GREY, 1.0)
    lighting.inputs["Strength"].default_value = AMBIENT_STRENGTH
    path = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    links.new(lighting.outputs["Background"], mix.inputs[1])
    links.new(seen.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])


def add_area_light(name, location, target, size, energy):
    light = bpy.data.lights.new(name, "AREA")
    light.size = size
    light.energy = energy
    obj = bpy.data.objects.new(name, light)
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = look_at_matrix(Vector(location), Vector(target), Vector((0, 0, 1)))


def setup_lights():
    add_area_light("Key", (-0.45, -0.3, 0.35), (0, 0, 0), 0.6, 14.0)
    add_area_light("Fill", (0.3, -0.35, 0.45), (0, 0, 0), 0.7, 8.0)
    add_area_light("BackLeft", (-0.4, 0.35, 0.3), (0, 0, 0), 0.6, 10.0)
    add_area_light("BackRight", (0.45, 0.3, -0.1), (0, 0, 0), 0.6, 6.0)
    add_area_light("Top", (0.0, 0.0, 0.7), (0, 0, 0), 0.7, 8.0)


def look_at_matrix(location, target, up):
    z_axis = (location - target).normalized()
    if abs(z_axis.dot(up.normalized())) > 0.999:
        up = Vector((0, 1, 0))
    x_axis = up.cross(z_axis).normalized()
    y_axis = z_axis.cross(x_axis)
    basis = Matrix((x_axis, y_axis, z_axis)).transposed().to_4x4()
    basis.translation = location
    return basis


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    objects = {obj.name: obj for obj in bpy.data.objects}
    return objects


class FoldRig:
    def __init__(self, objects):
        self.hinge = objects["Hinge"]
        self.rig = objects["Rig"]
        self.inner = objects["InnerScreen"]
        self.hinge_rest = self.hinge.matrix_world.copy()
        self.axis = self.hinge_rest.translation.copy()
        self.bone_rest = self.rig.data.bones["bone_cover"].matrix_local.copy()

    def set_fold(self, fold_deg):
        turn = (Matrix.Translation(self.axis) @ Matrix.Rotation(math.radians(REST_FOLD_DEG - fold_deg), 4, "Z")
                @ Matrix.Translation(-self.axis))
        self.hinge.matrix_world = turn @ self.hinge_rest
        rig_world = self.rig.matrix_world
        self.rig.pose.bones["bone_cover"].matrix = rig_world.inverted() @ turn @ rig_world @ self.bone_rest
        self.inner.hide_render = fold_deg < INNER_SCREEN_HIDDEN_BELOW_DEG
        bpy.context.view_layer.update()


def screen_pattern_material(material, extras):
    material.use_backface_culling = True
    tree = material.node_tree
    tree.nodes.clear()
    nodes, links = tree.nodes, tree.links

    def math_node(op, a, b=None, clamp=False):
        node = nodes.new("ShaderNodeMath")
        node.operation = op
        node.use_clamp = clamp
        for index, value in enumerate((a, b)):
            if value is None:
                continue
            if isinstance(value, (int, float)):
                node.inputs[index].default_value = value
            else:
                links.new(value, node.inputs[index])
        return node.outputs[0]

    uv = nodes.new("ShaderNodeUVMap")
    split = nodes.new("ShaderNodeSeparateXYZ")
    links.new(uv.outputs["UV"], split.inputs[0])
    u = split.outputs["X"]
    v = math_node("SUBTRACT", 1.0, split.outputs["Y"])
    pu, pv, pr = extras["punchHole"]
    ru, rv = extras["cornerRadiusUv"]
    v_to_u = ru / rv
    du = math_node("SUBTRACT", u, pu)
    dv = math_node("MULTIPLY", math_node("SUBTRACT", v, pv), v_to_u)
    hole_distance = math_node("SQRT", math_node("ADD", math_node("MULTIPLY", du, du), math_node("MULTIPLY", dv, dv)))
    outside_hole = math_node("GREATER_THAN", hole_distance, pr)
    qx = math_node("DIVIDE", math_node("MAXIMUM", math_node("SUBTRACT", math_node("ABSOLUTE", math_node("SUBTRACT", u, 0.5)), 0.5 - ru), 0.0), ru)
    qy = math_node("DIVIDE", math_node("MAXIMUM", math_node("SUBTRACT", math_node("ABSOLUTE", math_node("SUBTRACT", v, 0.5)), 0.5 - rv), 0.0), rv)
    inside_corner = math_node("LESS_THAN", math_node("ADD", math_node("MULTIPLY", qx, qx), math_node("MULTIPLY", qy, qy)), 1.0)
    grid_u = math_node("LESS_THAN", math_node("FRACT", math_node("MULTIPLY", u, 20.0)), 0.04)
    grid_v = math_node("LESS_THAN", math_node("FRACT", math_node("MULTIPLY", v, 20.0)), 0.04 * v_to_u)
    grid = math_node("MAXIMUM", grid_u, grid_v)
    marker = math_node("MULTIPLY", math_node("LESS_THAN", u, 0.12), math_node("GREATER_THAN", v, 0.88))
    grey = math_node("ADD", 0.18, math_node("MULTIPLY", grid, 0.25))
    visible = math_node("MULTIPLY", outside_hole, inside_corner)
    combine = nodes.new("ShaderNodeCombineXYZ")
    red = math_node("MULTIPLY", math_node("ADD", grey, math_node("MULTIPLY", marker, 0.5)), visible)
    green_blue = math_node("MULTIPLY", math_node("SUBTRACT", grey, math_node("MULTIPLY", marker, 0.12)), visible)
    links.new(red, combine.inputs[0])
    links.new(green_blue, combine.inputs[1])
    links.new(green_blue, combine.inputs[2])
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.3
    links.new(combine.outputs[0], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])


def assign_screen_patterns(objects):
    for screen, material_name in (("InnerScreen", "screen_inner"), ("CoverScreen", "screen_cover")):
        obj = objects[screen]
        extras = {key: list(obj[key]) for key in ("punchHole", "cornerRadiusUv")}
        screen_pattern_material(bpy.data.materials[material_name], extras)


def srgb_hex_to_linear(hex_color):
    hex_color = hex_color.lstrip("#")
    channels = [int(hex_color[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]


def apply_colorway(name):
    with open(os.path.join(MODEL_DIR, "colorways.json")) as handle:
        preset = json.load(handle)["colorways"][name]["materials"]
    for material_name, spec in preset.items():
        material = bpy.data.materials.get(material_name)
        if material is None:
            continue
        bsdf = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*srgb_hex_to_linear(spec["baseColor"]), 1.0)
        bsdf.inputs["Metallic"].default_value = spec["metallic"]
        bsdf.inputs["Roughness"].default_value = spec["roughness"]


def place_camera(view, size):
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    aspect = view["aspect"]
    scene.render.resolution_x = size if aspect >= 1 else round(size * aspect)
    scene.render.resolution_y = round(size / aspect) if aspect >= 1 else size
    scene.render.resolution_percentage = 100
    camera_data.clip_start = mm(1)
    camera_data.clip_end = 10.0
    if view["kind"] == "ortho":
        camera_data.type = "ORTHO"
        width, height = view["fit"]
        margin = 1.01
        camera_data.ortho_scale = max(width * margin, height * margin * aspect) if aspect >= 1 else \
            max(height * margin, width * margin / aspect)
        centre = Vector(view["centre"])
        forward = Vector(view["forward"])
        camera.matrix_world = look_at_matrix(centre - forward * 1.0, centre, Vector(view["up"]))
    else:
        camera_data.type = "PERSP"
        camera_data.lens = view["lens"]
        camera.matrix_world = look_at_matrix(Vector(view["location"]), Vector(view["target"]), Vector((0, 0, 1)))
    return camera


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_cycles(args.samples)
    setup_world()
    setup_lights()
    objects = import_glb(args.glb)
    rig = FoldRig(objects)
    assign_screen_patterns(objects)
    apply_colorway(args.colorway)
    os.makedirs(args.outdir, exist_ok=True)
    for name in args.views.split(","):
        view = ALL_VIEWS[name]
        camera = place_camera(view, args.size)
        rig.set_fold(view["fold"])
        bpy.context.scene.render.filepath = os.path.join(os.path.abspath(args.outdir), f"{name}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(camera)
        print(f"rendered {name}")


if __name__ == "__main__":
    main()
