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
    resetVideo: async () => { calls.push(["reset-video", undefined]); },
    setClipboard: async (m) => { calls.push(["set-clipboard", m]); },
    setDisplayPower: async (on) => { calls.push(["display-power", on]); },
    expandNotificationPanel: async () => { calls.push(["expand-notifications", undefined]); },
    expandSettingPanel: async () => { calls.push(["expand-settings", undefined]); },
    collapseNotificationPanel: async () => { calls.push(["collapse-panels", undefined]); },
    rotateDevice: async () => { calls.push(["rotate-device", undefined]); },
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

test("reset-video calls the controller's resetVideo", async () => {
  const { c, calls } = fake();
  await applyIntent(c, { type: "reset-video" });
  expect(calls).toEqual([["reset-video", undefined]]);
});

test("clipboard-paste with asText injects the PC clipboard text instead of setting the device clipboard", async () => {
  const { c, calls } = fake();
  await applyIntent(c, { type: "clipboard-paste", asText: true }, { readPcClipboard: async () => "hello" });
  expect(calls).toEqual([["text", "hello"]]);
});

test("clipboard-paste without asText sets the device clipboard with a fresh sequence and pastes", async () => {
  const { c, calls } = fake();
  await applyIntent(
    c,
    { type: "clipboard-paste", asText: false },
    { readPcClipboard: async () => "hello", beginClipboardPush: () => 7n },
  );
  expect(calls).toEqual([["set-clipboard", { content: "hello", sequence: 7n, paste: true }]]);
});

test("clipboard-paste is a no-op when no PC clipboard reader is wired", async () => {
  const { c, calls } = fake();
  await applyIntent(c, { type: "clipboard-paste", asText: false });
  expect(calls).toEqual([]);
});

test("shortcut intents map to their controller calls", async () => {
  const { c, calls } = fake();
  await applyIntent(c, { type: "display-power", on: false });
  await applyIntent(c, { type: "display-power", on: true });
  await applyIntent(c, { type: "expand-notifications" });
  await applyIntent(c, { type: "expand-settings" });
  await applyIntent(c, { type: "collapse-panels" });
  await applyIntent(c, { type: "rotate-device" });
  expect(calls).toEqual([
    ["display-power", false],
    ["display-power", true],
    ["expand-notifications", undefined],
    ["expand-settings", undefined],
    ["collapse-panels", undefined],
    ["rotate-device", undefined],
  ]);
});
