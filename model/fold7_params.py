"""Every dimension of the Fold 7 model, in millimetres, in the exported glTF frame.

Frame: +Y up along the long axis, +X right, +Z toward the viewer of the inner
screen in the fully open rest pose. The hinge line is X = 0, the fixed (camera)
half spans X >= 0, the cover half spans X <= 0, the back of both halves is Z = 0.

SpecDimensions come from the spec and fold7-reference.md. ImageEstimates are
measured from the official product images and are listed with their source image
in the M2 report.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SpecDimensions:
    body_open_width_mm: float = 143.2
    body_height_mm: float = 158.4
    body_open_thickness_mm: float = 4.2
    body_folded_thickness_mm: float = 8.9
    body_folded_width_mm: float = 72.8
    cover_active_width_mm: float = 65.0
    cover_active_height_mm: float = 151.7
    cover_pixels: tuple = (1080, 2520)
    inner_active_width_mm: float = 135.8
    inner_active_height_mm: float = 150.7
    inner_pixels: tuple = (1968, 2184)
    crease_band_width_mm: float = 6.0
    crease_band_min_loops: int = 12


@dataclass(frozen=True)
class ImageEstimates:
    outer_corner_radius_mm: float = 3.0
    frame_front_rim_width_mm: float = 0.85
    frame_back_rim_width_mm: float = 0.7
    frame_edge_round_mm: float = 0.3
    hinge_wall_round_mm: float = 0.6
    hinge_wall_top_mm: float = 3.7
    inner_screen_recess_mm: float = 0.08
    cover_screen_recess_mm: float = 0.08
    back_glass_thickness_mm: float = 0.6
    back_glass_edge_round_mm: float = 0.2
    screen_active_corner_radius_mm: float = 1.0

    inner_punch_hole_center_from_left_mm: float = 106.2
    inner_punch_hole_center_from_top_mm: float = 7.35
    inner_punch_hole_radius_mm: float = 2.2
    cover_punch_hole_center_from_top_mm: float = 6.85
    cover_punch_hole_radius_mm: float = 1.85

    camera_island_width_mm: float = 18.0
    camera_island_height_mm: float = 53.0
    camera_island_from_top_mm: float = 5.4
    camera_island_center_from_outer_edge_mm: float = 16.5
    camera_plate_height_mm: float = 0.9
    camera_plate_edge_round_mm: float = 0.35
    lens_ring_outer_radius_mm: float = 7.4
    lens_pitch_mm: float = 16.2
    lens_ring_height_mm: float = 0.9
    flash_center_from_outer_edge_mm: float = 33.7
    flash_center_from_top_mm: float = 23.7
    flash_radius_mm: float = 1.3

    volume_rocker_top_from_top_mm: float = 41.6
    volume_rocker_length_mm: float = 18.5
    volume_rocker_depth_mm: float = 1.7
    volume_rocker_protrusion_mm: float = 0.5
    power_key_top_from_top_mm: float = 66.3
    power_key_length_mm: float = 12.9
    power_key_depth_mm: float = 2.3
    power_key_protrusion_mm: float = 0.3

    usb_c_width_mm: float = 8.4
    usb_c_height_mm: float = 2.6
    speaker_hole_count: int = 5
    speaker_hole_diameter_mm: float = 1.1
    speaker_hole_pitch_mm: float = 1.8
    speaker_holes_center_from_hinge_mm: float = 47.0
    mic_hole_diameter_mm: float = 0.8
    earpiece_slot_length_mm: float = 7.0
    earpiece_slot_height_mm: float = 0.7
    sim_tray_center_from_hinge_mm: float = 20.0
    sim_tray_length_mm: float = 14.0
    sim_tray_height_mm: float = 1.9
    sim_pin_hole_from_hinge_mm: float = 11.5
    antenna_band_width_mm: float = 0.6
    antenna_bands_from_ends_on_outer_edge_mm: float = 15.0
    antenna_bands_from_outer_edge_on_top_bottom_mm: float = 18.0


@dataclass(frozen=True)
class Params:
    spec: SpecDimensions = field(default_factory=SpecDimensions)
    est: ImageEstimates = field(default_factory=ImageEstimates)

    @property
    def half_width_mm(self) -> float:
        return self.spec.body_open_width_mm / 2

    @property
    def half_height_mm(self) -> float:
        return self.spec.body_height_mm / 2

    @property
    def fold_gap_mm(self) -> float:
        return self.spec.body_folded_thickness_mm - 2 * self.spec.body_open_thickness_mm

    @property
    def hinge_axis_z_mm(self) -> float:
        return self.spec.body_open_thickness_mm + self.fold_gap_mm / 2

    @property
    def camera_bump_mm(self) -> float:
        return self.est.camera_plate_height_mm + self.est.lens_ring_height_mm

    @property
    def button_protrusion_mm(self) -> float:
        return max(self.est.volume_rocker_protrusion_mm, self.est.power_key_protrusion_mm)

    @property
    def expected_rest_bbox_mm(self) -> tuple:
        return (
            self.spec.body_open_width_mm + self.button_protrusion_mm,
            self.spec.body_height_mm,
            self.spec.body_open_thickness_mm + self.camera_bump_mm,
        )


P = Params()
