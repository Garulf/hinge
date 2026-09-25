import { expect, test } from "vitest";
import { ViewMemory, type ViewMode } from "../../src/renderer/view-memory";

function setup(initial: ViewMode = "work") {
  const applied: ViewMode[] = [];
  const saved: [string | null, ViewMode][] = [];
  const memory = new ViewMemory({ apply: (v) => applied.push(v), save: (s, v) => saved.push([s, v]) }, initial);
  return { memory, applied, saved };
}

test("starts on the last view chosen", () => {
  const { memory, applied } = setup("showcase");
  expect(memory.view).toBe("showcase");
  expect(applied).toEqual(["showcase"]);
});

test("toggling saves the view for the phone on screen", () => {
  const { memory, applied, saved } = setup();
  memory.toggle();
  memory.useDevice("A", undefined);
  memory.toggle();
  expect(applied).toEqual(["work", "showcase", "work"]);
  expect(saved).toEqual([
    [null, "showcase"],
    ["A", "work"],
  ]);
});

test("each phone gets its saved view when it streams; one with none keeps the current view", () => {
  const { memory, applied } = setup();
  memory.useDevice("A", "showcase");
  memory.useDevice("B", undefined);
  memory.useDevice("C", "work");
  expect(applied).toEqual(["work", "showcase", "work"]);
  expect(memory.view).toBe("work");
});

test("the same phone streaming again keeps what is on screen", () => {
  const { memory, applied } = setup();
  memory.useDevice("A", "work");
  memory.toggle();
  memory.useDevice("A", "work");
  expect(memory.view).toBe("showcase");
  expect(applied).toEqual(["work", "showcase"]);
});

test("a restored view lands at once while a toggled one eases", () => {
  const calls: [ViewMode, boolean][] = [];
  const memory = new ViewMemory({ apply: (v, opts) => calls.push([v, opts.instant]), save: () => {} }, "showcase");
  memory.useDevice("A", "work");
  memory.toggle();
  expect(calls).toEqual([
    ["showcase", true],
    ["work", true],
    ["showcase", false],
  ]);
});
