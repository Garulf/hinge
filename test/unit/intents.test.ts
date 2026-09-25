import { expect, test } from "vitest";
import { applyIntent, type ControllerLike } from "../../src/main/intents";

function fake() {
  const calls: [string, unknown][] = [];
  const c: ControllerLike = {
    injectTouch: async (m) => { calls.push(["touch", m]); },
    injectScroll: async (m) => { calls.push(["scroll", m]); },
    injectKeyCode: async (m) => { calls.push(["key", m]); },
    injectText: async (t) => { calls.push(["text", t]); },
    backOrScreenOn: async (a) => { calls.push(["back", a]); },
  };
  return { c, calls };
}

test("touch maps actions to Android motion actions and mouse pointer id to -1n", async () => {
  const { c, calls } = fake();
  await applyIntent(c, { type: "touch", action: "down", pointerId: -1, x: 10, y: 20, videoWidth: 100, videoHeight: 200, pressure: 1, buttons: 1 });
  await applyIntent(c, { type: "touch", action: "move", pointerId: -1, x: 11, y: 21, videoWidth: 100, videoHeight: 200, pressure: 1, buttons: 1 });
  await applyIntent(c, { type: "touch", action: "up", pointerId: -1, x: 11, y: 21, videoWidth: 100, videoHeight: 200, pressure: 0, buttons: 0 });
  await applyIntent(c, { type: "touch", action: "cancel", pointerId: -1, x: 11, y: 21, videoWidth: 100, videoHeight: 200, pressure: 0, buttons: 0 });
  expect(calls.map(([, m]) => (m as { action: number }).action)).toEqual([0, 2, 1, 3]);
  expect((calls[0][1] as { pointerId: bigint }).pointerId).toBe(-1n);
  expect(calls[0][1]).toMatchObject({ pointerX: 10, pointerY: 20, videoWidth: 100, videoHeight: 200 });
});

test("key, text, scroll and back map to their controller calls", async () => {
  const { c, calls } = fake();
  await applyIntent(c, { type: "key", action: "up", keyCode: 66, repeat: 0, metaState: 0 });
  await applyIntent(c, { type: "text", text: "héllo" });
  await applyIntent(c, { type: "scroll", x: 1, y: 2, videoWidth: 3, videoHeight: 4, scrollX: 0, scrollY: -1, buttons: 0 });
  await applyIntent(c, { type: "back-or-screen-on", action: "down" });
  expect(calls).toEqual([
    ["key", { action: 1, keyCode: 66, repeat: 0, metaState: 0 }],
    ["text", "héllo"],
    ["scroll", { pointerX: 1, pointerY: 2, videoWidth: 3, videoHeight: 4, scrollX: 0, scrollY: -1, buttons: 0 }],
    ["back", 0],
  ]);
});
