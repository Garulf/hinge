import { expect, test } from "vitest";
import { applyIntent, launchAppOnPhone, type ControllerLike } from "../../src/main/intents";

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

function fakeAdb(): unknown {
  return { marker: "adb" };
}

test("launchAppOnPhone resolves the launcher activity and starts it", async () => {
  const commands: string[] = [];
  const adb = fakeAdb();
  const runShell = async (seenAdb: unknown, command: string) => {
    expect(seenAdb).toBe(adb);
    commands.push(command);
    if (command.startsWith("cmd package resolve-activity")) return "com.example.chat/.MainActivity\n";
    return "";
  };
  await launchAppOnPhone(adb as never, "com.example.chat", () => {
    throw new Error("must not log on success");
  }, { runShell: runShell as never });
  expect(commands).toEqual([
    "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.chat",
    "am start -n com.example.chat/.MainActivity",
  ]);
});

test("launchAppOnPhone takes the last non-empty line of resolve-activity's output as the component", async () => {
  const commands: string[] = [];
  const runShell = async (_adb: unknown, command: string) => {
    commands.push(command);
    if (command.startsWith("cmd package resolve-activity")) {
      return "priority=0 preferredOrder=0 match=0x108000\ncom.example.chat/.MainActivity\n";
    }
    return "";
  };
  await launchAppOnPhone(fakeAdb() as never, "com.example.chat", () => {}, { runShell: runShell as never });
  expect(commands[1]).toBe("am start -n com.example.chat/.MainActivity");
});

test("launchAppOnPhone runs nothing on the phone for a name that is not a package", async () => {
  const commands: string[] = [];
  const logs: string[] = [];
  const runShell = async (_adb: unknown, command: string) => {
    commands.push(command);
    return "com.example.chat/.MainActivity\n";
  };
  await launchAppOnPhone(fakeAdb() as never, "x;reboot", (line) => logs.push(line), { runShell: runShell as never });
  expect(commands).toEqual([]);
  expect(logs).toHaveLength(1);
});

test("launchAppOnPhone starts nothing when the resolved component is not a plain component name", async () => {
  const commands: string[] = [];
  const logs: string[] = [];
  const runShell = async (_adb: unknown, command: string) => {
    commands.push(command);
    if (command.startsWith("cmd package resolve-activity")) return "com.example.chat/.Main;reboot\n";
    return "";
  };
  await launchAppOnPhone(fakeAdb() as never, "com.example.chat", (line) => logs.push(line), { runShell: runShell as never });
  expect(commands).toHaveLength(1);
  expect(logs).toHaveLength(1);
});

test("launchAppOnPhone logs, never throws, when nothing resolves", async () => {
  const logs: string[] = [];
  const runShell = async () => "";
  await launchAppOnPhone(fakeAdb() as never, "com.example.unknown", (line) => logs.push(line), { runShell: runShell as never });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("com.example.unknown");
});

test("launchAppOnPhone logs, never throws, when the shell command itself rejects", async () => {
  const logs: string[] = [];
  const runShell = async () => {
    throw new Error("adb offline");
  };
  await launchAppOnPhone(fakeAdb() as never, "com.example.chat", (line) => logs.push(line), { runShell: runShell as never });
  expect(logs[0]).toContain("adb offline");
});
