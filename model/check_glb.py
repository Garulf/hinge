"""Check the structure and dimensions of an exported fold7.glb.

Usage: uv run --with pygltflib model/check_glb.py <file.glb>
Prints one line per check and exits non-zero if any check fails.
"""

import math
import os
import struct
import sys

from pygltflib import GLTF2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fold7_params import P  # noqa: E402

REQUIRED_NODES = ["Root", "FixedHalf", "Hinge", "CoverHalf", "CoverScreen", "InnerScreen", "Rig"]
REQUIRED_BONES = ["bone_fixed", "bone_cover"]
REQUIRED_MATERIALS = [
    "frame", "back_glass", "hinge_spine", "camera_island", "lens_glass",
    "screen_border", "screen_cover", "screen_inner", "button", "port",
]
TRIANGLE_BUDGET = (60_000, 100_000)
MAX_FILE_BYTES = 5 * 1024 * 1024
BBOX_TOLERANCE_MM = 0.2
UV_TOLERANCE = 1e-4
SCREEN_EXTRAS = {
    "CoverScreen": {"pixelSize": list(P.spec.cover_pixels), "material": "screen_cover", "u_toward": -1},
    "InnerScreen": {"pixelSize": list(P.spec.inner_pixels), "material": "screen_inner", "u_toward": +1},
}

COMPONENT_FORMATS = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
TYPE_SIZES = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
NORMALIZED_DIVISORS = {5121: 255.0, 5123: 65535.0}


class Report:
    def __init__(self):
        self.failures = 0

    def check(self, name, ok, detail=""):
        status = "PASS" if ok else "FAIL"
        if not ok:
            self.failures += 1
        print(f"{status}  {name}" + (f": {detail}" if detail else ""))
        return ok


def mat_identity():
    return [[1.0 if r == c else 0.0 for c in range(4)] for r in range(4)]


def mat_mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def mat_from_column_major(values):
    return [[values[c * 4 + r] for c in range(4)] for r in range(4)]


def mat_from_trs(node):
    tx, ty, tz = node.translation or (0.0, 0.0, 0.0)
    qx, qy, qz, qw = node.rotation or (0.0, 0.0, 0.0, 1.0)
    sx, sy, sz = node.scale or (1.0, 1.0, 1.0)
    rot = [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ]
    return [
        [rot[0][0] * sx, rot[0][1] * sy, rot[0][2] * sz, tx],
        [rot[1][0] * sx, rot[1][1] * sy, rot[1][2] * sz, ty],
        [rot[2][0] * sx, rot[2][1] * sy, rot[2][2] * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def transform_point(m, p):
    return [m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3] for r in range(3)]


class Model:
    def __init__(self, path):
        self.gltf = GLTF2.load(path)
        self.blob = self.gltf.binary_blob()
        self.names = {node.name: index for index, node in enumerate(self.gltf.nodes)}
        self.parent = {}
        for index, node in enumerate(self.gltf.nodes):
            for child in node.children or []:
                self.parent[child] = index
        self._world = {}

    def node(self, name):
        return self.gltf.nodes[self.names[name]]

    def local_matrix(self, index):
        node = self.gltf.nodes[index]
        if node.matrix:
            return mat_from_column_major(node.matrix)
        return mat_from_trs(node)

    def world_matrix(self, index):
        if index not in self._world:
            local = self.local_matrix(index)
            parent = self.parent.get(index)
            self._world[index] = local if parent is None else mat_mul(self.world_matrix(parent), local)
        return self._world[index]

    def is_descendant(self, index, ancestor):
        while index in self.parent:
            index = self.parent[index]
            if index == ancestor:
                return True
        return False

    def read_accessor(self, accessor_index):
        accessor = self.gltf.accessors[accessor_index]
        view = self.gltf.bufferViews[accessor.bufferView]
        fmt = COMPONENT_FORMATS[accessor.componentType]
        width = TYPE_SIZES[accessor.type]
        item_size = struct.calcsize("<" + fmt * width)
        stride = view.byteStride or item_size
        base = (view.byteOffset or 0) + (accessor.byteOffset or 0)
        items = []
        for i in range(accessor.count):
            values = struct.unpack_from("<" + fmt * width, self.blob, base + i * stride)
            if accessor.normalized and accessor.componentType in NORMALIZED_DIVISORS:
                values = tuple(v / NORMALIZED_DIVISORS[accessor.componentType] for v in values)
            items.append(values)
        return items

    def material_name(self, primitive):
        if primitive.material is None:
            return None
        return self.gltf.materials[primitive.material].name

    def primitive_triangles(self, primitive):
        count = self.gltf.accessors[primitive.indices].count if primitive.indices is not None else \
            self.gltf.accessors[primitive.attributes.POSITION].count
        return count // 3 if primitive.mode in (None, 4) else 0

    def skin_matrices(self, skin_index):
        skin = self.gltf.skins[skin_index]
        inverse_binds = self.read_accessor(skin.inverseBindMatrices)
        return [
            mat_mul(self.world_matrix(joint), mat_from_column_major(ibm))
            for joint, ibm in zip(skin.joints, inverse_binds)
        ]

    def primitive_world_positions(self, node_index, primitive):
        node = self.gltf.nodes[node_index]
        positions = self.read_accessor(primitive.attributes.POSITION)
        if node.skin is None:
            world = self.world_matrix(node_index)
            return [transform_point(world, p) for p in positions]
        joint_matrices = self.skin_matrices(node.skin)
        joints = self.read_accessor(primitive.attributes.JOINTS_0)
        weights = self.read_accessor(primitive.attributes.WEIGHTS_0)
        result = []
        for p, js, ws in zip(positions, joints, weights):
            acc = [0.0, 0.0, 0.0]
            for j, w in zip(js, ws):
                if w:
                    q = transform_point(joint_matrices[j], p)
                    acc = [a + w * b for a, b in zip(acc, q)]
            result.append(acc)
        return result

    def mesh_nodes(self):
        return [i for i, node in enumerate(self.gltf.nodes) if node.mesh is not None]

    def node_positions_mm(self, name_or_index, material=None):
        index = self.names[name_or_index] if isinstance(name_or_index, str) else name_or_index
        node = self.gltf.nodes[index]
        points = []
        if node.mesh is None:
            return points
        for primitive in self.gltf.meshes[node.mesh].primitives:
            if material is None or self.material_name(primitive) == material:
                points.extend([c * 1000 for c in p] for p in self.primitive_world_positions(index, primitive))
        return points

    def subtree_positions_mm(self, name):
        root = self.names[name]
        points = []
        for index in self.mesh_nodes():
            if index == root or self.is_descendant(index, root):
                points.extend(self.node_positions_mm(index))
        return points


def bbox(points):
    return [min(p[a] for p in points) for a in range(3)], [max(p[a] for p in points) for a in range(3)]


def centre(points):
    low, high = bbox(points)
    return [(lo + hi) / 2 for lo, hi in zip(low, high)]


def fmt_vec(v):
    return "(" + ", ".join(f"{c:.2f}" for c in v) + ")"


def check_structure(model, report):
    missing = [n for n in REQUIRED_NODES + REQUIRED_BONES if n not in model.names]
    report.check("required nodes", not missing, f"missing {missing}" if missing else ", ".join(REQUIRED_NODES))
    core = ["Root", "FixedHalf", "Hinge", "CoverHalf", "Rig"] + REQUIRED_BONES
    if any(n not in model.names for n in core):
        return
    root = model.names["Root"]
    report.check(
        "hierarchy",
        "CoverScreen" in model.names
        and model.parent.get(model.names["FixedHalf"]) == root
        and model.parent.get(model.names["Hinge"]) == root
        and model.parent.get(model.names["CoverHalf"]) == model.names["Hinge"]
        and model.is_descendant(model.names["CoverScreen"], model.names["CoverHalf"])
        and model.is_descendant(model.names["Rig"], root),
        "Root > FixedHalf, Root > Hinge > CoverHalf > .. CoverScreen, Root > .. Rig",
    )
    rig = model.names["Rig"]
    bones_ok = all(model.is_descendant(model.names[b], rig) for b in REQUIRED_BONES)
    report.check("bones under Rig", bones_ok, ", ".join(REQUIRED_BONES))
    inner = model.node("InnerScreen") if "InnerScreen" in model.names else None
    skin_ok = inner is not None and inner.skin is not None and {model.names[b] for b in REQUIRED_BONES} <= set(
        model.gltf.skins[inner.skin].joints
    )
    report.check("InnerScreen skinned to both bones", skin_ok)
    hinge, bone = model.node("Hinge"), model.node("bone_cover")
    hinge_q, bone_q = hinge.rotation or [0, 0, 0, 1], bone.rotation or [0, 0, 0, 1]
    same_rotation = abs(abs(sum(a * b for a, b in zip(hinge_q, bone_q))) - 1) < 1e-5
    hinge_t = transform_point(model.world_matrix(model.names["Hinge"]), [0, 0, 0])
    bone_t = transform_point(model.world_matrix(model.names["bone_cover"]), [0, 0, 0])
    same_origin = max(abs(a - b) for a, b in zip(hinge_t, bone_t)) < 1e-6
    report.check(
        "bone_cover rest matches Hinge rest",
        same_rotation and same_origin,
        f"Hinge q={fmt_vec(hinge_q)} bone q={fmt_vec(bone_q)}",
    )
    about_y = abs(hinge_q[1]) > 0.999999 and abs(hinge_q[3]) < 1e-5
    report.check("Hinge rest rotation is 180 deg about Y", about_y, fmt_vec(hinge_q))


def check_materials(model, report):
    names = {m.name for m in model.gltf.materials}
    missing = [m for m in REQUIRED_MATERIALS if m not in names]
    report.check("required materials", not missing, f"missing {missing}" if missing else f"{len(names)} materials")


def check_extras(model, report):
    for screen, expected in SCREEN_EXTRAS.items():
        if screen not in model.names:
            report.check(f"{screen} extras", False, "node missing")
            continue
        extras = model.node(screen).extras or {}
        punch = extras.get("punchHole")
        radii = extras.get("cornerRadiusUv")
        pixels = extras.get("pixelSize")
        ok = (
            isinstance(punch, list) and len(punch) == 3 and 0 < punch[0] < 1 and 0 < punch[1] < 1 and 0 < punch[2] < 0.1
            and isinstance(radii, list) and len(radii) == 2 and all(0 < r < 0.5 for r in radii)
            and pixels == expected["pixelSize"]
        )
        report.check(f"{screen} extras", ok, f"punchHole={punch} cornerRadiusUv={radii} pixelSize={pixels}")


def check_budget(model, path, report):
    triangles = 0
    for index in model.mesh_nodes():
        for primitive in model.gltf.meshes[model.gltf.nodes[index].mesh].primitives:
            triangles += model.primitive_triangles(primitive)
    low, high = TRIANGLE_BUDGET
    report.check("triangle budget", low <= triangles <= high, f"{triangles} triangles (budget {low}..{high})")
    size = os.path.getsize(path)
    report.check("file size", size < MAX_FILE_BYTES, f"{size / 1024 / 1024:.2f} MB (limit 5 MB)")


def check_bbox(model, report):
    points = model.subtree_positions_mm("Root")
    low, high = bbox(points)
    size = [hi - lo for lo, hi in zip(low, high)]
    expected = P.expected_rest_bbox_mm
    ok = all(abs(s - e) <= BBOX_TOLERANCE_MM for s, e in zip(size, expected))
    report.check("rest bounding box", ok, f"{fmt_vec(size)} mm, expected {fmt_vec(expected)} +-{BBOX_TOLERANCE_MM}")


def screen_primitive_points(model, screen, material):
    if screen not in model.names:
        return None, [], []
    index = model.names[screen]
    node = model.gltf.nodes[index]
    for primitive in model.gltf.meshes[node.mesh].primitives if node.mesh is not None else []:
        if model.material_name(primitive) == material:
            uvs = model.read_accessor(primitive.attributes.TEXCOORD_0)
            positions = [[c * 1000 for c in p] for p in model.primitive_world_positions(index, primitive)]
            return primitive, positions, uvs
    return None, [], []


def check_screen_uvs(model, report):
    for screen, expected in SCREEN_EXTRAS.items():
        primitive, positions, uvs = screen_primitive_points(model, screen, expected["material"])
        if primitive is None:
            report.check(f"{screen} UV range", False, f"no {expected['material']} primitive on {screen}")
            continue
        us, vs = [uv[0] for uv in uvs], [uv[1] for uv in uvs]
        in_range = all(
            abs(a - b) <= UV_TOLERANCE for a, b in ((min(us), 0), (max(us), 1), (min(vs), 0), (max(vs), 1))
        )
        report.check(f"{screen} UV range", in_range, f"u {min(us):.5f}..{max(us):.5f}, v {min(vs):.5f}..{max(vs):.5f}")
        u_low, u_high = positions[us.index(min(us))], positions[us.index(max(us))]
        v_low, v_high = positions[vs.index(min(vs))], positions[vs.index(max(vs))]
        u_ok = (u_high[0] - u_low[0]) * expected["u_toward"] > 0
        v_ok = v_high[1] - v_low[1] > 0
        direction = "+X" if expected["u_toward"] > 0 else "-X"
        report.check(f"{screen} UV direction", u_ok and v_ok, f"u toward {direction}, v toward +Y")


def check_crease(model, report):
    primitive, positions, uvs = screen_primitive_points(model, "InnerScreen", "screen_inner")
    if primitive is None:
        report.check("crease band", False, "no screen_inner primitive")
        return
    half_band = P.spec.crease_band_width_mm / 2
    loops = sorted({round(p[0], 4) for p in positions if abs(p[0]) < half_band - 1e-6})
    report.check(
        "crease band loops",
        len(loops) >= P.spec.crease_band_min_loops,
        f"{len(loops)} vertex loops strictly inside |x| < {half_band} mm",
    )
    unique = {tuple(round(c, 5) for c in p) for p in positions}
    report.check("inner screen has no seam", len(unique) == len(positions), f"{len(positions)} verts, {len(unique)} unique")
    node = model.node("InnerScreen")
    joints = model.read_accessor(primitive.attributes.JOINTS_0)
    weights = model.read_accessor(primitive.attributes.WEIGHTS_0)
    skin_joints = model.gltf.skins[node.skin].joints
    cover_joint = skin_joints.index(model.names["bone_cover"])
    bad = 0
    for p, js, ws in zip(positions, joints, weights):
        cover_weight = sum(w for j, w in zip(js, ws) if j == cover_joint)
        if p[0] >= half_band and cover_weight > 1e-4:
            bad += 1
        if p[0] <= -half_band and cover_weight < 1 - 1e-4:
            bad += 1
    report.check("crease weights outside the band", bad == 0, f"{bad} vertices with wrong weights")


def check_sides(model, report):
    rules = [
        ("CoverScreen", lambda c: c[0] < 0, "centre X < 0"),
        ("CameraIsland", lambda c: c[0] > 0 and c[2] < 0, "centre X > 0 and Z < 0"),
        ("PowerKey", lambda c: c[0] > 0, "centre X > 0"),
    ]
    for name, rule, text in rules:
        if name not in model.names:
            report.check(f"{name} side", False, "node missing")
            continue
        points = model.subtree_positions_mm(name)
        if not points:
            report.check(f"{name} side", False, "no geometry")
            continue
        c = centre(points)
        report.check(f"{name} side", rule(c), f"{text}, centre {fmt_vec(c)} mm")


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    model = Model(path)
    report = Report()
    check_structure(model, report)
    check_materials(model, report)
    check_extras(model, report)
    check_budget(model, path, report)
    check_bbox(model, report)
    check_screen_uvs(model, report)
    check_crease(model, report)
    check_sides(model, report)
    print(f"{'FAILED' if report.failures else 'OK'}: {report.failures} failing check(s)")
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
