"""Mesh-building helpers on top of bmesh.

Geometry is described in phone millimetres (the glTF frame of fold7_params.py)
and converted to Blender metres (Z up) when vertices are created.
"""

import math
from dataclasses import dataclass

import bmesh
from mathutils import Vector

MERGE_DISTANCE_M = 1e-7


def mm(value):
    return value * 0.001


def phone_to_blender(x, y, z):
    return Vector((mm(x), mm(-z), mm(y)))


def blender_to_phone(v):
    return (v.x * 1000.0, v.z * 1000.0, -v.y * 1000.0)


def smoothstep(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


@dataclass
class Sample:
    u: float
    v: float
    nu: float
    nv: float
    edge: str
    hinge: bool


CORNERS = ("bl", "br", "tr", "tl")
EDGE_INWARD = {"bottom": (0.0, 1.0), "right": (-1.0, 0.0), "top": (0.0, -1.0), "left": (1.0, 0.0)}
EDGE_BEFORE = {"bl": "left", "br": "bottom", "tr": "right", "tl": "top"}
EDGE_AFTER = {"bl": "bottom", "br": "right", "tr": "top", "tl": "left"}
EDGE_ALONG_U = {"bottom": True, "top": True, "left": False, "right": False}


def rounded_rect(u0, u1, v0, v1, radii, arc_segments, max_step=None, edge_counts=None,
                 hinge_edge=None, cuts=None):
    """Counter-clockwise samples of a rounded rectangle.

    radii maps corner name to radius; a radius of 0 gives a sharp corner that
    emits one sample per adjacent edge, so the two edges can use different
    profiles. edge_counts fixes the number of interior samples per edge, which
    lets two rectangles be sampled with matching indices. cuts maps an edge
    name to extra positions (u for bottom/top, v for left/right) to sample at.
    """
    corner_points = {"bl": (u0, v0), "br": (u1, v0), "tr": (u1, v1), "tl": (u0, v1)}
    samples = []
    for index, corner in enumerate(CORNERS):
        radius = radii[corner]
        cu, cv = corner_points[corner]
        before, after = EDGE_BEFORE[corner], EDGE_AFTER[corner]
        nb, na = EDGE_INWARD[before], EDGE_INWARD[after]
        if radius <= 0:
            miter = (nb[0] + na[0], nb[1] + na[1])
            samples.append(Sample(cu, cv, *miter, before, before == hinge_edge))
            samples.append(Sample(cu, cv, *miter, after, after == hinge_edge))
            edge_start = (cu, cv)
        else:
            centre = (cu + radius * (nb[0] + na[0]), cv + radius * (nb[1] + na[1]))
            start = math.atan2(-nb[1], -nb[0])
            end = math.atan2(-na[1], -na[0])
            if end < start:
                end += 2 * math.pi
            for step in range(arc_segments + 1):
                angle = start + (end - start) * step / arc_segments
                ou, ov = math.cos(angle), math.sin(angle)
                samples.append(Sample(centre[0] + radius * ou, centre[1] + radius * ov, -ou, -ov, "corner", False))
            edge_start = (centre[0] - radius * na[0], centre[1] - radius * na[1])
        next_corner = CORNERS[(index + 1) % 4]
        next_radius = radii[next_corner]
        nu_, nv_ = corner_points[next_corner]
        nn = EDGE_INWARD[EDGE_BEFORE[next_corner]]
        nn_after = EDGE_INWARD[EDGE_AFTER[next_corner]]
        if next_radius <= 0:
            edge_end = (nu_, nv_)
        else:
            centre = (nu_ + next_radius * (nn[0] + nn_after[0]), nv_ + next_radius * (nn[1] + nn_after[1]))
            edge_end = (centre[0] - next_radius * nn[0], centre[1] - next_radius * nn[1])
        samples.extend(_edge_interior(after, edge_start, edge_end, max_step, edge_counts, hinge_edge, cuts))
    return _drop_repeats(samples)


def _edge_interior(edge, start, end, max_step, edge_counts, hinge_edge, cuts):
    along_u = EDGE_ALONG_U[edge]
    a, b = (start[0], end[0]) if along_u else (start[1], end[1])
    length = abs(b - a)
    if edge_counts is not None:
        count = edge_counts[edge]
    elif max_step:
        count = max(0, math.ceil(length / max_step) - 1)
    else:
        count = 0
    positions = [a + (b - a) * (i + 1) / (count + 1) for i in range(count)]
    lo, hi = min(a, b), max(a, b)
    for cut in (cuts or {}).get(edge, []):
        if lo + 1e-6 < cut < hi - 1e-6:
            positions.append(cut)
    positions.sort(reverse=b < a)
    inward = EDGE_INWARD[edge]
    fixed = start[1] if along_u else start[0]
    return [
        Sample(p if along_u else fixed, fixed if along_u else p, inward[0], inward[1], edge, edge == hinge_edge)
        for p in positions
    ]


def _drop_repeats(samples):
    result = []
    for sample in samples:
        if result:
            last = result[-1]
            same_spot = abs(last.u - sample.u) < 1e-9 and abs(last.v - sample.v) < 1e-9
            if same_spot and last.hinge == sample.hinge:
                continue
        result.append(sample)
    if len(result) > 1:
        first, last = result[0], result[-1]
        if abs(first.u - last.u) < 1e-9 and abs(first.v - last.v) < 1e-9 and first.hinge == last.hinge:
            result.pop()
    return result


def circle(cu, cv, radius, segments):
    samples = []
    for step in range(segments):
        angle = 2 * math.pi * step / segments
        ou, ov = math.cos(angle), math.sin(angle)
        samples.append(Sample(cu + radius * ou, cv + radius * ov, -ou, -ov, "corner", False))
    return samples


def stadium(cu, cv, length_v, width_u, arc_segments):
    radius = width_u / 2
    half_v = length_v / 2
    return rounded_rect(cu - radius, cu + radius, cv - half_v, cv + half_v, dict.fromkeys(CORNERS, radius),
                        arc_segments)


def arc(centre_d, centre_h, radius, start_deg, end_deg, segments, kind):
    points = []
    for step in range(segments + 1):
        angle = math.radians(start_deg + (end_deg - start_deg) * step / segments)
        points.append((centre_d + radius * math.cos(angle), centre_h + radius * math.sin(angle), kind))
    return points


def sweep(bm, samples, place, profile, hinge_profile=None, closed_profile=True, cap_start=False,
          cap_end=False, material_of=lambda seg_class, kind: 0, segment_class=None):
    """Sweep a (d, h, kind) profile along closed outline samples.

    d offsets a sample inward along its miter, h is the height passed to
    place(u, v, h) which returns phone millimetres. kind labels the span from a
    profile point to the next and is passed to material_of together with the
    segment class returned by segment_class(sample, next_sample).
    """
    rings = []
    for sample in samples:
        points = hinge_profile if (sample.hinge and hinge_profile) else profile
        rings.append([
            bm.verts.new(phone_to_blender(*place(sample.u + sample.nu * d, sample.v + sample.nv * d, h)))
            for d, h, _ in points
        ])
    count = len(samples)
    span_count = len(profile) if closed_profile else len(profile) - 1
    faces = []
    for i in range(count):
        a, b = rings[i], rings[(i + 1) % count]
        seg = segment_class(samples[i], samples[(i + 1) % count]) if segment_class else None
        for k in range(span_count):
            k2 = (k + 1) % len(profile)
            face = bm.faces.new((a[k], b[k], b[k2], a[k2]))
            face.material_index = material_of(seg, profile[k][2])
            faces.append(face)
    if cap_start:
        face = bm.faces.new([ring[0] for ring in rings])
        face.material_index = material_of(None, profile[0][2])
        faces.append(face)
    if cap_end:
        face = bm.faces.new([ring[-1] for ring in rings])
        face.material_index = material_of(None, profile[-1][2])
        faces.append(face)
    return faces


def finish_solid(bm):
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=MERGE_DISTANCE_M)
    degenerate = [f for f in bm.faces if f.calc_area() < 1e-14]
    bmesh.ops.delete(bm, geom=degenerate, context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def screen_panel(bm, outer, active, height, facing_blender, cuts_u, cuts_v, border_index, active_index):
    """A flat screen: a border strip between two matching outlines plus the active area,
    split along the given u and v planes and triangulated."""
    if len(outer) != len(active):
        raise ValueError(f"outline sample counts differ: {len(outer)} != {len(active)}")
    outer_verts = [bm.verts.new(phone_to_blender(s.u, s.v, height)) for s in outer]
    active_verts = [bm.verts.new(phone_to_blender(s.u, s.v, height)) for s in active]
    count = len(outer)
    for i in range(count):
        j = (i + 1) % count
        face = bm.faces.new((outer_verts[i], outer_verts[j], active_verts[j], active_verts[i]))
        face.material_index = border_index
    face = bm.faces.new(active_verts)
    face.material_index = active_index
    split_along_planes(bm, cuts_u, cuts_v)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
    face_toward(bm, facing_blender)


def split_along_planes(bm, cuts_u, cuts_v):
    for u in cuts_u:
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-9, plane_co=phone_to_blender(u, 0, 0),
                               plane_no=Vector((1, 0, 0)))
    for v in cuts_v:
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-9, plane_co=phone_to_blender(0, v, 0),
                               plane_no=Vector((0, 0, 1)))


def face_toward(bm, direction_blender):
    for face in bm.faces:
        face.normal_update()
    flips = [f for f in bm.faces if f.normal.dot(direction_blender) < 0]
    if flips:
        bmesh.ops.reverse_faces(bm, faces=flips)


def grid_positions(lo, hi, step):
    count = max(1, round((hi - lo) / step))
    return [lo + (hi - lo) * i / count for i in range(1, count)]
