import { expect, test } from "vitest";
import { RotationMemory } from "../../src/renderer/rotation-memory";
import type { ModelAngles } from "../../src/shared/model-rotation";

function setup() {
  const calls: string[] = [];
  const saved: [string, ModelAngles][] = [];
  const memory = new RotationMemory({
    set: (a) => calls.push(`set ${a.yaw},${a.pitch}`),
    springToRest: () => calls.push("spring"),
    save: (id, a) => saved.push([id, a]),
  });
  return { memory, calls, saved };
}

test("each phone gets its saved turn at once when it streams, and one with none starts at rest", () => {
  const { memory, calls } = setup();
  memory.useDevice("A", { yaw: 30, pitch: -10 });
  memory.useDevice("B", undefined);
  expect(calls).toEqual(["set 30,-10", "set 0,0"]);
});

test("the same phone streaming again keeps the turn on screen", () => {
  const { memory, calls } = setup();
  memory.useDevice("A", { yaw: 30, pitch: 0 });
  memory.useDevice("A", { yaw: 0, pitch: 0 });
  expect(calls).toEqual(["set 30,0"]);
});

test("a finished drag is saved for the phone on screen; before any phone nothing is saved", () => {
  const { memory, saved } = setup();
  memory.turned({ yaw: 10, pitch: 5 });
  memory.useDevice("A", undefined);
  memory.turned({ yaw: 20, pitch: 5 });
  expect(saved).toEqual([["A", { yaw: 20, pitch: 5 }]]);
});

test("a reset springs back to rest and saves rest for the phone on screen", () => {
  const { memory, calls, saved } = setup();
  memory.reset();
  memory.useDevice("A", { yaw: 30, pitch: 0 });
  memory.reset();
  expect(calls).toEqual(["spring", "set 30,0", "spring"]);
  expect(saved).toEqual([["A", { yaw: 0, pitch: 0 }]]);
});
