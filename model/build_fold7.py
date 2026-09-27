"""Build the Galaxy Z Fold 7 model in Blender and export it as glTF binary.

Run headless in Blender 5.2:
    blender -b --factory-startup --python build_fold7.py -- --out fold7.glb [--pose-test]
"""

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fold7_params import P  # noqa: E402
from meshkit import (  # noqa: E402
    CORNERS, arc, blender_to_phone, face_toward, finish_solid, grid_positions, mm, phone_to_blender,
    circle, rounded_rect, screen_panel, smoothstep, split_along_planes, stadium, sweep,
)

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
REST_FOLD_DEG = 180.0
POSE_TEST_ANGLES_DEG = (0.0, 100.0, 180.0)
HINGE_SEAM_CLEARANCE_MM = 0.02
CORNER_ARC_SEGMENTS = 24
FRAME_EDGE_STEP_MM = 1.5
PROFILE_ROUND_SEGMENTS = 5
SCREEN_GRID_STEP_MM = 2.5
CREASE_LOOP_COUNT = 24
HINGE_FILL_HALF_WIDTH_MM = 3.5
HINGE_FILL_CLEARANCE_MM = 0.06
HINGE_FILL_THICKNESS_MM = 0.06
DISPLAY_PANEL_BELOW_FILL_MM = 0.05
DISPLAY_PANEL_MARGIN_MM = 1.6
SMOOTH_ANGLE_DEG = 40.0
LENS_SEGMENTS = 128
ISLAND_ARC_SEGMENTS = 48
SMALL_HOLE_SEGMENTS = 24
BUTTON_ARC_SEGMENTS = 12
HOLE_DEPTH_MM = 0.5
PHONE_PLUS_Z_IN_BLENDER = Vector((0, -1, 0))


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


# Materials ------------------------------------------------------------------

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
    "lens_ring": {"baseColor": "#505054", "metallic": 1.0, "roughness": 0.35},
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


class Slots:
    """Material slot indices for one mesh object, in first-use order."""

    def __init__(self, materials, *names):
        self.materials = materials
        self.names = list(names)

    def __getitem__(self, name):
        if name not in self.names:
            self.names.append(name)
        return self.names.index(name)

    def assign(self, mesh):
        for name in self.names:
            mesh.materials.append(self.materials[name])


# Objects and hierarchy ------------------------------------------------------

def link(obj, parent):
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        bpy.context.view_layer.update()
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj


def new_empty(name, parent=None, location=Vector()):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "PLAIN_AXES"
    empty.empty_display_size = mm(10)
    empty.location = location
    return link(empty, parent)


def mesh_object(name, bm, slots, parent, shading="auto"):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    slots.assign(mesh)
    if shading in ("auto", "smooth"):
        mesh.shade_smooth()
    if shading == "auto":
        mesh.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE_DEG))
    return link(bpy.data.objects.new(name, mesh), parent)


def hinge_axis_blender():
    return phone_to_blender(0.0, 0.0, P.hinge_axis_z_mm)


def hinge_rotation_z(fold_deg):
    return -math.radians(fold_deg)


def build_rig(root):
    armature = bpy.data.armatures.new("Rig")
    rig = link(bpy.data.objects.new("Rig", armature), root)
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


class Phone:
    def __init__(self, materials):
        self.materials = materials
        self.root = new_empty("Root")
        self.fixed_half = new_empty("FixedHalf", self.root)
        self.hinge = new_empty("Hinge", self.root, hinge_axis_blender())
        self.hinge.rotation_euler = (0.0, 0.0, hinge_rotation_z(REST_FOLD_DEG))
        bpy.context.view_layer.update()
        self.cover_half = new_empty("CoverHalf", self.hinge)
        self.cover_half.matrix_world = Matrix.Identity(4)
        bpy.context.view_layer.update()
        self.rig = build_rig(self.root)

    def half(self, side):
        return self.fixed_half if side > 0 else self.cover_half


# Body -----------------------------------------------------------------------

def half_bounds(side):
    outer = P.half_width_mm
    seam = HINGE_SEAM_CLEARANCE_MM / 2
    return (seam, outer) if side > 0 else (-outer, -seam)


def hinge_edge_name(side):
    return "left" if side > 0 else "right"


def half_radii(side, outer_radius, hinge_radius=0.0):
    hinge_corners = ("bl", "tl") if side > 0 else ("br", "tr")
    return {c: (hinge_radius if c in hinge_corners else outer_radius) for c in CORNERS}


def antenna_bands(side):
    e = P.est
    half_w, half_h = P.half_width_mm, P.half_height_mm
    outer_edge = "right" if side > 0 else "left"
    along_outer = half_h - e.antenna_bands_from_ends_on_outer_edge_mm
    across = side * (half_w - e.antenna_bands_from_outer_edge_on_top_bottom_mm)
    centres = [(outer_edge, along_outer), (outer_edge, -along_outer), ("top", across), ("bottom", across)]
    half_band = e.antenna_band_width_mm / 2
    return [(edge, c - half_band, c + half_band) for edge, c in centres]


def frame_profile(back_rim, back_inner, top, front_rim, front_inner, back_round, front_round):
    points = [(back_rim, back_inner, "frame"), (back_rim, 0.0, "edge")]
    points += arc(back_round, back_round, back_round, 270, 180, PROFILE_ROUND_SEGMENTS, "edge")
    points += arc(front_round, top - front_round, front_round, 180, 90, PROFILE_ROUND_SEGMENTS, "edge")
    points += [(front_rim, top, "frame"), (front_rim, front_inner, "hidden")]
    return points


def frame_profiles(side):
    e = P.est
    top = P.spec.body_open_thickness_mm
    lip = top - e.inner_screen_recess_mm - 0.17
    if side > 0:
        back_rim, back_inner = e.frame_back_rim_width_mm, e.back_glass_thickness_mm
    else:
        back_rim, back_inner = e.cover_frame_rim_width_mm, e.cover_screen_recess_mm + 0.17
    normal = frame_profile(back_rim, back_inner, top, e.frame_front_rim_width_mm, lip,
                           e.frame_edge_round_mm, e.frame_edge_round_mm)
    hinge = frame_profile(back_rim, back_inner, e.hinge_wall_top_mm, e.frame_front_rim_width_mm,
                          e.hinge_wall_top_mm - 0.2, e.hinge_wall_round_mm, e.hinge_wall_round_mm)
    return normal, hinge


def build_frame(phone, side):
    u0, u1 = half_bounds(side)
    half_h = P.half_height_mm
    hinge_edge = hinge_edge_name(side)
    bands = antenna_bands(side)
    cuts = {}
    for edge, lo, hi in bands:
        cuts.setdefault(edge, []).extend([lo, hi])
    samples = rounded_rect(u0, u1, -half_h, half_h, half_radii(side, P.est.outer_corner_radius_mm),
                           CORNER_ARC_SEGMENTS, max_step=FRAME_EDGE_STEP_MM, hinge_edge=hinge_edge, cuts=cuts)

    def segment_class(a, b):
        if a.edge == hinge_edge and b.edge == hinge_edge:
            return "hinge"
        if a.edge != b.edge:
            return "frame"
        along = (a.u + b.u) / 2 if a.edge in ("top", "bottom") else (a.v + b.v) / 2
        if any(edge == a.edge and lo < along < hi for edge, lo, hi in bands):
            return "antenna"
        return "frame"

    slots = Slots(phone.materials, "frame", "hinge_spine", "antenna_band", "port")
    edge_material = {"hinge": "hinge_spine", "antenna": "antenna_band", "frame": "frame", None: "frame"}

    def material_of(seg, kind):
        if kind == "edge":
            return slots[edge_material[seg]]
        return slots["port" if kind == "hidden" else "frame"]

    normal, hinge = frame_profiles(side)
    bm = bmesh.new()
    sweep(bm, samples, lambda u, v, h: (u, v, h), normal, hinge_profile=hinge,
          material_of=material_of, segment_class=segment_class)
    finish_solid(bm)
    name = "FixedFrame" if side > 0 else "CoverFrame"
    return mesh_object(name, bm, slots, phone.half(side))


def build_back_glass(phone):
    e = P.est
    inset = e.frame_back_rim_width_mm
    u0, u1 = half_bounds(+1)
    half_h = P.half_height_mm
    samples = rounded_rect(u0 + inset, u1 - inset, -half_h + inset, half_h - inset,
                           half_radii(+1, e.outer_corner_radius_mm - inset), CORNER_ARC_SEGMENTS,
                           max_step=FRAME_EDGE_STEP_MM)
    r = e.back_glass_edge_round_mm
    profile = [(0.0, e.back_glass_thickness_mm, "glass"), (0.0, r, "glass")]
    profile += arc(r, r, r, 180, 270, PROFILE_ROUND_SEGMENTS, "glass")[1:]
    slots = Slots(phone.materials, "back_glass")
    bm = bmesh.new()
    sweep(bm, samples, lambda u, v, h: (u, v, h), profile, closed_profile=False, cap_start=True,
          cap_end=True, material_of=lambda seg, kind: slots["back_glass"])
    finish_solid(bm)
    return mesh_object("BackGlass", bm, slots, phone.fixed_half)


def inner_screen_height_mm():
    return P.spec.body_open_thickness_mm - P.est.inner_screen_recess_mm


def hinge_fill_top_mm():
    return inner_screen_height_mm() - P.spec.crease_depth_mm - HINGE_FILL_CLEARANCE_MM


def hinge_fill_bottom_mm():
    return hinge_fill_top_mm() - HINGE_FILL_THICKNESS_MM


def build_display_panel(phone, side):
    margin = DISPLAY_PANEL_MARGIN_MM
    outer = P.half_width_mm - margin
    inner = HINGE_FILL_HALF_WIDTH_MM - 0.2
    u0, u1 = (inner, outer) if side > 0 else (-outer, -inner)
    v0, v1 = -P.half_height_mm + margin, P.half_height_mm - margin
    z = hinge_fill_bottom_mm() - DISPLAY_PANEL_BELOW_FILL_MM
    bm = bmesh.new()
    verts = [bm.verts.new(phone_to_blender(u, v, z)) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    bm.faces.new(verts)
    face_toward(bm, PHONE_PLUS_Z_IN_BLENDER)
    slots = Slots(phone.materials, "screen_border")
    name = "FixedDisplayPanel" if side > 0 else "CoverDisplayPanel"
    return mesh_object(name, bm, slots, phone.half(side), shading="flat")


# Screens and crease -----------------------------------------------------------

def crease_loop_positions():
    half_band = P.spec.crease_band_width_mm / 2
    return [-half_band + 2 * half_band * i / CREASE_LOOP_COUNT for i in range(CREASE_LOOP_COUNT + 1)]


def cover_weight(x_mm):
    half_band = P.spec.crease_band_width_mm / 2
    return smoothstep((half_band - x_mm) / (2 * half_band))


def crease_dip_mm(x_mm):
    half_band = P.spec.crease_band_width_mm / 2
    if abs(x_mm) >= half_band:
        return 0.0
    return P.spec.crease_depth_mm * (1.0 + math.cos(math.pi * x_mm / half_band)) / 2


def press_crease(bm):
    for vert in bm.verts:
        x, y, z = blender_to_phone(vert.co)
        vert.co = phone_to_blender(x, y, z - crease_dip_mm(x))


def screen_cuts(u0, u1, v0, v1, extra_u=()):
    cuts_u = sorted(set(round(c, 6) for c in list(grid_positions(u0, u1, SCREEN_GRID_STEP_MM)) + list(extra_u)))
    return cuts_u, grid_positions(v0, v1, SCREEN_GRID_STEP_MM)


def assign_uvs(mesh, uv_of):
    layer = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        x, y, _ = blender_to_phone(mesh.vertices[loop.vertex_index].co)
        u, v = uv_of(x, y)
        layer.data[loop.index].uv = (u, 1.0 - v)


def assign_crease_weights(obj):
    fixed_group = obj.vertex_groups.new(name="bone_fixed")
    cover_group = obj.vertex_groups.new(name="bone_cover")
    for vertex in obj.data.vertices:
        x, _, _ = blender_to_phone(vertex.co)
        w = cover_weight(x)
        if w < 1.0:
            fixed_group.add([vertex.index], 1.0 - w, "REPLACE")
        if w > 0.0:
            cover_group.add([vertex.index], w, "REPLACE")
    modifier = obj.modifiers.new("Rig", "ARMATURE")
    return modifier


def build_inner_screen(phone):
    s, e = P.spec, P.est
    inset = e.frame_front_rim_width_mm
    half_w, half_h = P.half_width_mm - inset, P.half_height_mm - inset
    active_w, active_h = s.inner_active_width_mm / 2, s.inner_active_height_mm / 2
    counts = dict.fromkeys(("bottom", "right", "top", "left"), 0)
    outer = rounded_rect(-half_w, half_w, -half_h, half_h, dict.fromkeys(CORNERS, e.outer_corner_radius_mm - inset),
                         CORNER_ARC_SEGMENTS, edge_counts=counts)
    active = rounded_rect(-active_w, active_w, -active_h, active_h,
                          dict.fromkeys(CORNERS, e.screen_active_corner_radius_mm), CORNER_ARC_SEGMENTS,
                          edge_counts=counts)
    slots = Slots(phone.materials, "screen_border", "screen_inner")
    bm = bmesh.new()
    cuts_u, cuts_v = screen_cuts(-half_w, half_w, -half_h, half_h, crease_loop_positions())
    screen_panel(bm, outer, active, inner_screen_height_mm(), PHONE_PLUS_Z_IN_BLENDER, cuts_u, cuts_v,
                 slots["screen_border"], slots["screen_inner"])
    press_crease(bm)
    obj = mesh_object("InnerScreen", bm, slots, phone.fixed_half, shading="smooth")
    assign_uvs(obj.data, lambda x, y: ((x + active_w) / (2 * active_w), (y + active_h) / (2 * active_h)))
    assign_crease_weights(obj).object = phone.rig
    left = (P.spec.body_open_width_mm - s.inner_active_width_mm) / 2
    top = (P.spec.body_height_mm - s.inner_active_height_mm) / 2
    obj["punchHole"] = [
        (e.inner_punch_hole_center_from_left_mm - left) / s.inner_active_width_mm,
        1.0 - (e.inner_punch_hole_center_from_top_mm - top) / s.inner_active_height_mm,
        e.inner_punch_hole_radius_mm / s.inner_active_width_mm,
    ]
    obj["cornerRadiusUv"] = [e.screen_active_corner_radius_mm / s.inner_active_width_mm,
                             e.screen_active_corner_radius_mm / s.inner_active_height_mm]
    obj["pixelSize"] = list(s.inner_pixels)
    return obj


def build_hinge_fill(phone):
    half_w = HINGE_FILL_HALF_WIDTH_MM
    half_h = P.half_height_mm - P.est.frame_front_rim_width_mm - 0.05
    bm = bmesh.new()
    bottom, top = hinge_fill_bottom_mm(), hinge_fill_top_mm()
    corners = [(u, v) for u, v in ((-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h))]
    low = [bm.verts.new(phone_to_blender(u, v, bottom)) for u, v in corners]
    high = [bm.verts.new(phone_to_blender(u, v, top)) for u, v in corners]
    bm.faces.new(low[::-1])
    bm.faces.new(high)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((low[i], low[j], high[j], high[i]))
    split_along_planes(bm, crease_loop_positions(), [])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    slots = Slots(phone.materials, "hinge_spine")
    obj = mesh_object("HingeFill", bm, slots, phone.fixed_half)
    assign_crease_weights(obj).object = phone.rig
    return obj


def build_cover_screen(phone):
    s, e = P.spec, P.est
    inset = e.cover_frame_rim_width_mm
    u0, u1 = half_bounds(-1)
    half_h = P.half_height_mm - inset
    centre_u = -P.half_width_mm / 2
    active_w, active_h = s.cover_active_width_mm / 2, s.cover_active_height_mm / 2
    counts = dict.fromkeys(("bottom", "right", "top", "left"), 0)
    outer_radii = half_radii(-1, e.outer_corner_radius_mm - inset, hinge_radius=0.4)
    outer = rounded_rect(u0 + inset, u1 - inset, -half_h, half_h, outer_radii, CORNER_ARC_SEGMENTS,
                         edge_counts=counts)
    active = rounded_rect(centre_u - active_w, centre_u + active_w, -active_h, active_h,
                          dict.fromkeys(CORNERS, e.screen_active_corner_radius_mm), CORNER_ARC_SEGMENTS,
                          edge_counts=counts)
    slots = Slots(phone.materials, "screen_border", "screen_cover")
    bm = bmesh.new()
    cuts_u, cuts_v = screen_cuts(u0 + inset, u1 - inset, -half_h, half_h)
    screen_panel(bm, outer, active, e.cover_screen_recess_mm, -PHONE_PLUS_Z_IN_BLENDER, cuts_u, cuts_v,
                 slots["screen_border"], slots["screen_cover"])
    obj = mesh_object("CoverScreen", bm, slots, phone.cover_half, shading="smooth")
    right_edge = centre_u + active_w
    assign_uvs(obj.data, lambda x, y: ((right_edge - x) / s.cover_active_width_mm, (y + active_h) / (2 * active_h)))
    top = (P.spec.body_height_mm - s.cover_active_height_mm) / 2
    obj["punchHole"] = [
        0.5,
        1.0 - (e.cover_punch_hole_center_from_top_mm - top) / s.cover_active_height_mm,
        e.cover_punch_hole_radius_mm / s.cover_active_width_mm,
    ]
    obj["cornerRadiusUv"] = [e.screen_active_corner_radius_mm / s.cover_active_width_mm,
                             e.screen_active_corner_radius_mm / s.cover_active_height_mm]
    obj["pixelSize"] = list(s.cover_pixels)
    return obj


# Camera island, buttons, ports ------------------------------------------------

def on_back(u, v, h):
    return (u, v, -h)


def camera_island_centre():
    e = P.est
    return (P.half_width_mm - e.camera_island_center_from_outer_edge_mm,
            P.half_height_mm - e.camera_island_from_top_mm - e.camera_island_height_mm / 2)


def lens_profile(outer_radius, base, top):
    rounding = 0.25
    radial = [
        (outer_radius, base, "ring"),
        (outer_radius, top - rounding, "ring"),
    ]
    radial += [(r, h, "ring") for r, h, _ in arc(outer_radius - rounding, top - rounding, rounding, 0, 90, 4, "ring")[1:]]
    radial += [
        (outer_radius - 0.55, top, "ring"),
        (outer_radius - 0.75, top - 0.12, "ring"),
        (outer_radius - 0.8, top - 0.25, "bezel"),
        (outer_radius - 1.0, top - 0.3, "bezel"),
        (outer_radius - 2.6, top - 0.32, "bezel"),
        (outer_radius - 2.8, top - 0.4, "glass"),
        (3.2, top - 0.4, "glass"),
        (2.2, top - 0.37, "glass"),
        (1.1, top - 0.35, "glass"),
        (0.0, top - 0.34, "glass"),
    ]
    return [(outer_radius - r, h, kind) for r, h, kind in radial]


def build_camera_island(phone):
    e = P.est
    cu, cv = camera_island_centre()
    slots = Slots(phone.materials, "camera_island", "lens_ring", "lens_glass")
    kind_material = {"island": "camera_island", "ring": "lens_ring", "bezel": "lens_glass", "glass": "lens_glass"}
    bm = bmesh.new()
    rounding = e.camera_plate_edge_round_mm
    plate_top = e.camera_plate_height_mm
    plate_profile = [(0.0, -0.05, "island"), (0.06, plate_top - rounding, "island")]
    plate_profile += arc(0.06 + rounding, plate_top - rounding, rounding, 180, 90, PROFILE_ROUND_SEGMENTS, "island")[1:]
    outline = stadium(cu, cv, e.camera_island_height_mm, e.camera_island_width_mm, ISLAND_ARC_SEGMENTS)
    sweep(bm, outline, on_back, plate_profile, closed_profile=False, cap_start=True, cap_end=True,
          material_of=lambda seg, kind: slots[kind_material[kind]])
    lens_top = plate_top + e.lens_ring_height_mm
    for offset in (-1, 0, 1):
        ring = circle(cu, cv + offset * e.lens_pitch_mm, e.lens_ring_outer_radius_mm, LENS_SEGMENTS)
        sweep(bm, ring, on_back, lens_profile(e.lens_ring_outer_radius_mm, plate_top - 0.05, lens_top),
              closed_profile=False, cap_start=True, material_of=lambda seg, kind: slots[kind_material[kind]])
    finish_solid(bm)
    return mesh_object("CameraIsland", bm, slots, phone.fixed_half)


def build_flash(phone):
    e = P.est
    u = P.half_width_mm - e.flash_center_from_outer_edge_mm
    v = P.half_height_mm - e.flash_center_from_top_mm
    r = e.flash_radius_mm
    profile = [(0.0, -0.05, "flash"), (0.0, 0.02, "flash"), (0.25, 0.05, "flash"), (r, 0.06, "flash")]
    slots = Slots(phone.materials, "flash")
    bm = bmesh.new()
    sweep(bm, circle(u, v, r, 48), on_back, profile, closed_profile=False, cap_start=True,
          material_of=lambda seg, kind: slots["flash"])
    finish_solid(bm)
    return mesh_object("Flash", bm, slots, phone.fixed_half)


def button_profile(protrusion, rounding):
    points = [(0.0, -0.2, "button"), (0.0, protrusion - rounding, "button")]
    points += arc(rounding, protrusion - rounding, rounding, 180, 90, 4, "button")[1:]
    return points


def build_button(phone, name, top_from_top, length, depth, protrusion, rounding):
    v_centre = P.spec.body_open_thickness_mm / 2
    u_top = P.half_height_mm - top_from_top
    outline = rounded_rect(u_top - length, u_top, v_centre - depth / 2, v_centre + depth / 2,
                           dict.fromkeys(CORNERS, depth / 2 - 1e-4), BUTTON_ARC_SEGMENTS, max_step=1.5)
    slots = Slots(phone.materials, "button")
    bm = bmesh.new()
    sweep(bm, outline, lambda u, v, h: (P.half_width_mm + h, u, v), button_profile(protrusion, rounding),
          closed_profile=False, cap_start=True, cap_end=True, material_of=lambda seg, kind: slots["button"])
    finish_solid(bm)
    return mesh_object(name, bm, slots, phone.fixed_half)


def build_buttons(phone):
    e = P.est
    build_button(phone, "VolumeRocker", e.volume_rocker_top_from_top_mm, e.volume_rocker_length_mm,
                 e.volume_rocker_depth_mm, e.volume_rocker_protrusion_mm, 0.25)
    build_button(phone, "PowerKey", e.power_key_top_from_top_mm, e.power_key_length_mm,
                 e.power_key_depth_mm, e.power_key_protrusion_mm, 0.12)


def edge_place(edge):
    half_h = P.half_height_mm
    if edge == "top":
        return lambda u, v, h: (u, half_h - h, v)
    return lambda u, v, h: (u, -half_h + h, v)


def cutter_prism(bm, outline, place, depth):
    profile = [(0.0, -1.0, "port"), (0.0, depth, "port")]
    sweep(bm, outline, place, profile, closed_profile=False, cap_start=True, cap_end=True)


def cutter_groove(bm, outline, place, width, depth):
    half = width / 2
    profile = [(-half, -1.0, "port"), (half, -1.0, "port"), (half, depth, "port"), (-half, depth, "port")]
    sweep(bm, outline, place, profile)


def port_cutters(side):
    e = P.est
    mid = P.spec.body_open_thickness_mm / 2
    cutters = []
    hole = lambda u, v, d: circle(u, v, d / 2, SMALL_HOLE_SEGMENTS)  # noqa: E731
    if side < 0:
        usb_u = -P.half_width_mm / 2
        cutters.append(("bottom", rounded_rect(usb_u - e.usb_c_width_mm / 2, usb_u + e.usb_c_width_mm / 2,
                                               mid - e.usb_c_height_mm / 2, mid + e.usb_c_height_mm / 2,
                                               dict.fromkeys(CORNERS, e.usb_c_height_mm / 2 - 1e-4), 12), 0.7))
        first = -e.speaker_holes_center_from_hinge_mm - (e.speaker_hole_count - 1) / 2 * e.speaker_hole_pitch_mm
        for i in range(e.speaker_hole_count):
            cutters.append(("bottom", hole(first + i * e.speaker_hole_pitch_mm, mid, e.speaker_hole_diameter_mm),
                            HOLE_DEPTH_MM))
        cutters.append(("bottom", hole(-22.0, mid, e.mic_hole_diameter_mm), HOLE_DEPTH_MM))
        cutters.append(("top", hole(-22.0, mid, e.mic_hole_diameter_mm), HOLE_DEPTH_MM))
        earpiece_v = 1.0
        cutters.append(("top", rounded_rect(usb_u - e.earpiece_slot_length_mm / 2, usb_u + e.earpiece_slot_length_mm / 2,
                                            earpiece_v - e.earpiece_slot_height_mm / 2,
                                            earpiece_v + e.earpiece_slot_height_mm / 2,
                                            dict.fromkeys(CORNERS, e.earpiece_slot_height_mm / 2 - 1e-4), 8),
                        HOLE_DEPTH_MM))
    else:
        cutters.append(("bottom", hole(22.0, mid, e.mic_hole_diameter_mm), HOLE_DEPTH_MM))
        cutters.append(("top", hole(45.0, mid, e.mic_hole_diameter_mm), HOLE_DEPTH_MM))
        cutters.append(("top", hole(e.sim_pin_hole_from_hinge_mm, mid, e.mic_hole_diameter_mm), 0.6))
    return cutters


def sim_tray_groove():
    e = P.est
    mid = P.spec.body_open_thickness_mm / 2
    u = e.sim_tray_center_from_hinge_mm
    return rounded_rect(u - e.sim_tray_length_mm / 2, u + e.sim_tray_length_mm / 2, mid - e.sim_tray_height_mm / 2,
                        mid + e.sim_tray_height_mm / 2, dict.fromkeys(CORNERS, e.sim_tray_height_mm / 2 - 1e-4), 12)


def cut_ports(phone, frame, side):
    slots_material = phone.materials["port"]
    bm = bmesh.new()
    for edge, outline, depth in port_cutters(side):
        cutter_prism(bm, outline, edge_place(edge), depth)
    if side > 0:
        cutter_groove(bm, sim_tray_groove(), edge_place("top"), 0.12, 0.12)
    finish_solid(bm)
    mesh = bpy.data.meshes.new(frame.name + "Cutters")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(slots_material)
    cutter = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.scene.collection.objects.link(cutter)
    boolean = frame.modifiers.new("Ports", "BOOLEAN")
    boolean.operation = "DIFFERENCE"
    boolean.solver = "EXACT"
    boolean.material_mode = "TRANSFER"
    boolean.object = cutter
    depsgraph = bpy.context.evaluated_depsgraph_get()
    result = bpy.data.meshes.new_from_object(frame.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                             depsgraph=depsgraph)
    frame.modifiers.clear()
    old_mesh = frame.data
    frame.data = result
    result.name = old_mesh.name
    bpy.data.meshes.remove(old_mesh)
    bpy.data.objects.remove(cutter)
    bpy.data.meshes.remove(mesh)
    result.shade_smooth()
    result.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE_DEG))


def build_phone(materials):
    phone = Phone(materials)
    for side in (+1, -1):
        frame = build_frame(phone, side)
        cut_ports(phone, frame, side)
        build_display_panel(phone, side)
    build_back_glass(phone)
    build_camera_island(phone)
    build_flash(phone)
    build_buttons(phone)
    build_inner_screen(phone)
    build_hinge_fill(phone)
    build_cover_screen(phone)
    return phone


# Posing and the pose test -------------------------------------------------------

def set_fold(phone, fold_deg):
    phone.hinge.rotation_euler = (0.0, 0.0, hinge_rotation_z(fold_deg))
    axis = hinge_axis_blender()
    turn = (Matrix.Translation(axis) @ Matrix.Rotation(math.radians(REST_FOLD_DEG - fold_deg), 4, "Z")
            @ Matrix.Translation(-axis))
    pose_bone = phone.rig.pose.bones["bone_cover"]
    pose_bone.matrix = turn @ phone.rig.data.bones["bone_cover"].matrix_local
    bpy.context.view_layer.update()


def descendants(obj):
    result = []
    for child in obj.children:
        result.append(child)
        result.extend(descendants(child))
    return result


def rigid_meshes(half):
    return [o for o in descendants(half) if o.type == "MESH" and not o.modifiers]


def world_geometry(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts, polys = [], []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        offset = len(verts)
        verts.extend(obj.matrix_world @ v.co for v in mesh.vertices)
        polys.extend([offset + i for i in p.vertices] for p in mesh.polygons)
        evaluated.to_mesh_clear()
    return verts, polys


def pose_test(phone):
    failures = 0
    for fold_deg in POSE_TEST_ANGLES_DEG:
        set_fold(phone, fold_deg)
        fixed_verts, fixed_polys = world_geometry(rigid_meshes(phone.fixed_half))
        cover_verts, cover_polys = world_geometry(rigid_meshes(phone.cover_half))
        fixed_mm = [blender_to_phone(v) for v in fixed_verts]
        cover_mm = [blender_to_phone(v) for v in cover_verts]
        low = [min(p[a] for p in fixed_mm) for a in range(3)]
        high = [max(p[a] for p in fixed_mm) for a in range(3)]
        margin = 1e-3
        inside = sum(
            all(low[a] + margin < p[a] < high[a] - margin for a in range(3)) for p in cover_mm
        )
        overlaps = BVHTree.FromPolygons(fixed_verts, fixed_polys).overlap(
            BVHTree.FromPolygons(cover_verts, cover_polys))
        line = (f"fold {fold_deg:5.1f} deg: cover vertices inside fixed bbox: {'yes' if inside else 'no'} ({inside}), "
                f"intersecting triangle pairs: {len(overlaps)}")
        ok = inside == 0 and not overlaps
        if fold_deg == 0.0:
            gap = min(p[2] for p in cover_mm) - max(p[2] for p in fixed_mm)
            gap_ok = 0.0 <= gap <= P.fold_gap_mm + 1e-6
            line += f", closed gap {gap:.3f} mm (0..0.5)"
            ok = ok and gap_ok
        line += "  PASS" if ok else "  FAIL"
        print(line)
        failures += 0 if ok else 1
    set_fold(phone, REST_FOLD_DEG)
    return failures


# Export -----------------------------------------------------------------------

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
    phone = build_phone(create_materials())
    if args.pose_test and pose_test(phone):
        sys.exit(1)
    if args.out:
        export_glb(args.out)


if __name__ == "__main__":
    main()
