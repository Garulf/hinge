import { expect, test } from "vitest";
import { parseSample, parseStatesTable, postureOfName, POSTURE_ANGLE, samplesEqual } from "../../src/shared/posture";

const PRINT_STATES = `Supported states: [
  DeviceState{identifier=0, name='CLOSED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=1, name='TENT', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=2, name='HALF_OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=3, name='OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=4, name='CONCURRENT_INNER_DEFAULT', app_accessible=true, cancel_when_requester_not_on_top=true},
  DeviceState{identifier=5, name='CONCURRENT_OUTER_DEFAULT', app_accessible=true, cancel_when_requester_not_on_top=false},
]`;

test("parses the Fold 7 state table", () => {
  const t = parseStatesTable(PRINT_STATES);
  expect([...t.entries()]).toEqual([[0, "CLOSED"], [1, "TENT"], [2, "HALF_OPENED"], [3, "OPENED"], [4, "CONCURRENT_INNER_DEFAULT"], [5, "CONCURRENT_OUTER_DEFAULT"]]);
});

test("maps names to postures, HALF before OPEN, concurrent and rear modes to null", () => {
  expect(postureOfName("CLOSED")).toBe("closed");
  expect(postureOfName("FOLDED")).toBe("closed");
  expect(postureOfName("TENT")).toBe("tent");
  expect(postureOfName("HALF_OPENED")).toBe("half");
  expect(postureOfName("HALF_FOLDED")).toBe("half");
  expect(postureOfName("OPENED")).toBe("open");
  expect(postureOfName("CONCURRENT_INNER_DEFAULT")).toBeNull();
  expect(postureOfName("REAR_DISPLAY")).toBeNull();
});

test("parses a sampler sample: bare id, rotation line, size line", () => {
  const t = parseStatesTable(PRINT_STATES);
  expect(parseSample(["2", "mRotation=1 mDeferredRotationPauseCount=0", "Physical size: 1968x2184"], t))
    .toEqual({ stateId: 2, posture: "half", rotation: 1 });
});

test("accepts the DeviceState form of print-state and missing rotation", () => {
  const t = parseStatesTable(PRINT_STATES);
  expect(parseSample(["DeviceState{identifier=3, name='OPENED', app_accessible=true}"], t)).toEqual({ stateId: 3, posture: "open", rotation: null });
});

test("unknown ids and empty tables give a null posture, not a crash", () => {
  expect(parseSample(["7"], new Map())).toEqual({ stateId: 7, posture: null, rotation: null });
  expect(parseSample([], new Map())).toEqual({ stateId: null, posture: null, rotation: null });
});

test("angles", () => expect(POSTURE_ANGLE).toEqual({ closed: 0, tent: 30, half: 100, open: 180 }));

test("only rotations 0-3 are accepted; anything else is treated as missing", () => {
  const t = parseStatesTable(PRINT_STATES);
  expect(parseSample(["0", "mRotation=4 mDeferredRotationPauseCount=0"], t)).toEqual({ stateId: 0, posture: "closed", rotation: null });
});

test("samplesEqual compares all three fields", () => {
  expect(samplesEqual({ stateId: 2, posture: "half", rotation: 1 }, { stateId: 2, posture: "half", rotation: 1 })).toBe(true);
  expect(samplesEqual({ stateId: 2, posture: "half", rotation: 1 }, { stateId: 2, posture: "half", rotation: 0 })).toBe(false);
  expect(samplesEqual({ stateId: 2, posture: "half", rotation: 1 }, { stateId: 3, posture: "half", rotation: 1 })).toBe(false);
  expect(samplesEqual({ stateId: 2, posture: "half", rotation: 1 }, { stateId: 2, posture: "open", rotation: 1 })).toBe(false);
});

test("real hardware: opening the Fold 7 walks CLOSED to OPENED, HALF_OPENED switching to the inner panel size", () => {
  const t = parseStatesTable(PRINT_STATES);
  expect(parseSample(["0", "mRotation=0 mDeferredRotationPauseCount=0", "Physical size: 1080x2520"], t)).toEqual({ stateId: 0, posture: "closed", rotation: 0 });
  expect(parseSample(["1", "mRotation=0 mDeferredRotationPauseCount=0", "Physical size: 1080x2520"], t)).toEqual({ stateId: 1, posture: "tent", rotation: 0 });
  expect(parseSample(["2", "mRotation=0 mDeferredRotationPauseCount=0", "Physical size: 1968x2184"], t)).toEqual({ stateId: 2, posture: "half", rotation: 0 });
  expect(parseSample(["3", "mRotation=0 mDeferredRotationPauseCount=0", "Physical size: 1968x2184"], t)).toEqual({ stateId: 3, posture: "open", rotation: 0 });
});
