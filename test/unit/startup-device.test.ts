import { expect, test } from "vitest";
import { startupDevice } from "../../src/shared/settings";
import { DEFAULT_SETTINGS } from "../../src/main/settings";

test("the last phone's saved settings are known at startup, before it streams", () => {
  expect(startupDevice({ ...DEFAULT_SETTINGS, lastDevice: "R5CY", devices: { R5CY: { pxPerMm: 5, rotation: { yaw: 20, pitch: 0 } } } })).toEqual({
    id: "R5CY",
    saved: { pxPerMm: 5, rotation: { yaw: 20, pitch: 0 } },
  });
  expect(startupDevice({ ...DEFAULT_SETTINGS, lastDevice: "10.0.0.5:5555", legacyDevices: { "10.0.0.5:5555": { pxPerMm: 4 } } })).toEqual({
    id: "10.0.0.5:5555",
    saved: { pxPerMm: 4 },
  });
  expect(startupDevice({ ...DEFAULT_SETTINGS, lastDevice: "R5CY" })).toEqual({ id: "R5CY", saved: {} });
  expect(startupDevice(DEFAULT_SETTINGS)).toBeNull();
});
