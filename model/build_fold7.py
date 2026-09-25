"""Build the Galaxy Z Fold 7 model in Blender and export it as glTF binary.

Run headless in Blender 5.2:
    blender -b --factory-startup --python build_fold7.py -- --out fold7.glb [--pose-test]
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fold7_params import P  # noqa: E402

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
REST_FOLD_DEG = 180.0


def mm(value):
    return value * 0.001


def phone_to_blender(x, y, z):
    return Vector((mm(x), mm(-z), mm(y)))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="build_fold7.py")
    parser.add_argument("--out", help="path of the .glb to write")
    parser.add_argument("--pose-test", action="store_true")
    return parser.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


def srgb_hex_to_linear(hex_color):
    hex_color = hex_color.lstrip("#")
    channels = [int(hex_color[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]


def load_default_colorway():
    with open(os.path.join(MODEL_DIR, "colorways.json")) as handle:
        data = json.load(handle)
    return data["colorways"][data["default"]]["materials"]


FIXED_MATERIALS = {
    "lens_glass": {"baseColor": "#050506", "metallic": 0.0, "roughness": 0.05},
    "screen_border": {"baseColor": "#020202", "metallic": 0.0, "roughness": 0.1},
    "screen_cover": {"baseColor": "#000000", "metallic": 0.0, "roughness": 0.1},
    "screen_inner": {"baseColor": "#000000", "metallic": 0.0, "roughness": 0.1},
    "port": {"baseColor": "#0a0a0b", "metallic": 0.0, "roughness": 0.6},
    "lens_ring": {"baseColor": "#3a3a3d", "metallic": 1.0, "roughness": 0.25},
    "flash": {"baseColor": "#efe6cc", "metallic": 0.0, "roughness": 0.35},
}


def create_materials():
    specs = dict(FIXED_MATERIALS)
    specs.update(load_default_colorway())
    materials = {}
    for name, spec in specs.items():
        material = bpy.data.materials.new(name)
        bsdf = material.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*srgb_hex_to_linear(spec["baseColor"]), 1.0)
        bsdf.inputs["Metallic"].default_value = spec["metallic"]
        bsdf.inputs["Roughness"].default_value = spec["roughness"]
        materials[name] = material
    return materials


def new_empty(name, parent=None, location=Vector()):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "PLAIN_AXES"
    empty.empty_display_size = mm(10)
    bpy.context.scene.collection.objects.link(empty)
    empty.location = location
    if parent is not None:
        empty.parent = parent
    return empty


def mesh_object_from_bmesh(name, bm, materials, parent):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for material in materials:
        mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    return obj


def placeholder_box(name, x0, x1, material, parent):
    import bmesh

    bm = bmesh.new()
    y0, y1 = -P.half_height_mm, P.half_height_mm
    z0, z1 = 0.0, P.spec.body_open_thickness_mm
    corners = [phone_to_blender(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    verts = [bm.verts.new(c) for c in corners]
    for face in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        bm.faces.new([verts[i] for i in face])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object_from_bmesh(name, bm, [material], parent)


def hinge_axis_blender():
    return phone_to_blender(0.0, 0.0, P.hinge_axis_z_mm)


def hinge_rotation_z(fold_deg):
    return -math.radians(fold_deg)


def build_rig(root):
    armature = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", armature)
    bpy.context.scene.collection.objects.link(rig)
    rig.parent = root
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    bone_length = mm(20)
    fixed = armature.edit_bones.new("bone_fixed")
    fixed.head = Vector((0, 0, 0))
    fixed.tail = Vector((0, 0, bone_length))
    fixed.roll = 0.0
    cover = armature.edit_bones.new("bone_cover")
    cover.head = hinge_axis_blender()
    cover.tail = cover.head + Vector((0, 0, bone_length))
    cover.roll = math.pi
    cover.parent = fixed
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def build_hierarchy(materials):
    root = new_empty("Root")
    fixed_half = new_empty("FixedHalf", root)
    hinge = new_empty("Hinge", root, hinge_axis_blender())
    hinge.rotation_euler = (0.0, 0.0, hinge_rotation_z(REST_FOLD_DEG))
    bpy.context.view_layer.update()
    cover_half = new_empty("CoverHalf", hinge)
    cover_half.matrix_world = Matrix.Identity(4)
    rig = build_rig(root)
    return root, fixed_half, hinge, cover_half, rig


def build_placeholder_geometry(fixed_half, cover_half, materials):
    placeholder_box("FixedBody", 0.0, P.half_width_mm, materials["frame"], fixed_half)
    cover_body = placeholder_box("CoverBody", -P.half_width_mm, 0.0, materials["frame"], None)
    parent_keep_world(cover_body, cover_half)


def parent_keep_world(obj, parent):
    world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)
    bpy.context.view_layer.update()
    obj.matrix_world = world


def export_glb(path):
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_skins=True,
        export_extras=True,
        export_materials="EXPORT",
        export_texcoords=True,
        export_normals=True,
        export_animations=False,
    )
    print(f"exported {path} ({os.path.getsize(path)} bytes)")


def main():
    args = parse_args()
    reset_scene()
    materials = create_materials()
    root, fixed_half, hinge, cover_half, rig = build_hierarchy(materials)
    build_placeholder_geometry(fixed_half, cover_half, materials)
    if args.out:
        export_glb(args.out)


if __name__ == "__main__":
    main()
