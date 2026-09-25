import { expect, test } from "vitest";
import { SampleAssembler, SAMPLER_SCRIPT } from "../../src/main/posture-sampler";

test("groups lines between tick markers into samples", () => {
  const a = new SampleAssembler();
  expect(a.push("@@hinge-tick 1")).toBeNull();
  expect(a.push("Committed state: DeviceState{identifier=0, name='CLOSED'}")).toBeNull();
  expect(a.push("    mRotation=0 mDeferredRotationPauseCount=0")).toBeNull();
  expect(a.push("@@hinge-tick 2")).toEqual({ tick: 1, lines: ["Committed state: DeviceState{identifier=0, name='CLOSED'}", "mRotation=0 mDeferredRotationPauseCount=0"] });
});

test("the script is one shell loop with a tick marker and a sleep", () => {
  expect(SAMPLER_SCRIPT).toMatch(/while true/);
  expect(SAMPLER_SCRIPT).toMatch(/@@hinge-tick/);
  expect(SAMPLER_SCRIPT).toMatch(/cmd device_state print-state/);
  expect(SAMPLER_SCRIPT).toMatch(/sleep 0\.25/);
});

test("samples rotation from dumpsys window displays, since SurfaceOrientation prints nothing on Android 16", () => {
  expect(SAMPLER_SCRIPT).toMatch(/dumpsys window displays/);
  expect(SAMPLER_SCRIPT).toMatch(/mRotation=/);
  expect(SAMPLER_SCRIPT).not.toMatch(/SurfaceOrientation/);
});
