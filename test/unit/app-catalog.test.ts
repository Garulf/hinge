import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseAgentApps, parseAgentIcons, parseLauncherActivities, parseRecents } from "../../src/shared/app-catalog";

// Both *-aosp.txt fixtures are written from the AOSP dump formats, not captured from a real phone.
const RECENTS = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-activity-recents-aosp.txt"), "utf8");
const LAUNCHERS = readFileSync(join(import.meta.dirname, "../fixtures/query-activities-aosp.txt"), "utf8");

test("parseAgentApps reads the agent's app list", () => {
  const json = '[{"pkg":"com.example.chat","label":"Chat","versionCode":42},{"pkg":"com.example.maps","label":"Maps","versionCode":9007199254740}]';
  expect(parseAgentApps(json)).toEqual([
    { pkg: "com.example.chat", label: "Chat", versionCode: 42 },
    { pkg: "com.example.maps", label: "Maps", versionCode: 9007199254740 },
  ]);
});

test("parseAgentApps falls back to the package for a blank label and drops entries without a package", () => {
  const json = '[{"pkg":"com.example.blank","label":"  ","versionCode":1},{"label":"No package","versionCode":2},{"pkg":"com.example.odd","label":"Odd","versionCode":"x"}]';
  expect(parseAgentApps(json)).toEqual([
    { pkg: "com.example.blank", label: "com.example.blank", versionCode: 1 },
    { pkg: "com.example.odd", label: "Odd", versionCode: null },
  ]);
});

test("parseAgentApps drops any package that is not a package name, so none reaches a shell command or a file path", () => {
  const hostile = ["../../../../Desktop/x", "a;reboot", "$(reboot)", "a b", "com..x", "com.example.ok/../x"];
  const json = JSON.stringify([...hostile.map((pkg) => ({ pkg, label: "Evil", versionCode: 1 })), { pkg: "com.example.ok", label: "Ok", versionCode: 1 }]);
  expect(parseAgentApps(json)).toEqual([{ pkg: "com.example.ok", label: "Ok", versionCode: 1 }]);
});

test("parseAgentApps throws when the output is not an array", () => {
  expect(() => parseAgentApps('{"pkg":"com.example.chat"}')).toThrow();
  expect(() => parseAgentApps("hinge-agent: boom")).toThrow();
});

test("parseAgentIcons decodes each package's base64 PNG and skips anything that is not a string", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const json = JSON.stringify({ "com.example.chat": Buffer.from(png).toString("base64"), "com.example.bad": 7 });
  const icons = parseAgentIcons(json);
  expect(Object.keys(icons)).toEqual(["com.example.chat"]);
  expect([...icons["com.example.chat"]]).toEqual([...png]);
});

test("parseAgentIcons drops any key that is not a package name", () => {
  const png = Buffer.from([1, 2, 3]).toString("base64");
  expect(Object.keys(parseAgentIcons(JSON.stringify({ "../../x": png, "a;b": png, "com.example.ok": png })))).toEqual(["com.example.ok"]);
});

test("parseAgentIcons throws when the output is not an object", () => {
  expect(() => parseAgentIcons("[]")).toThrow();
  expect(() => parseAgentIcons("null")).toThrow();
});

test("parseRecents lists each recent task's package in order, once, from its component before its affinity", () => {
  expect(parseRecents(RECENTS)).toEqual([
    "com.example.chat",
    "com.example.maps",
    "com.android.systemui",
    "com.example.notes",
    "com.example.browser",
    "com.example.camera",
    "com.example.mail",
    "com.example.music",
  ]);
});

test("parseRecents names a task with a custom affinity by its component's package", () => {
  const text = "  * Recent #0: Task{1 #3 type=standard A=10300:com.example.mail.compose U=0}\n    intent={flg=0x10080001 cmp=com.example.mail/.ComposeActivity}\n";
  expect(parseRecents(text)).toEqual(["com.example.mail"]);
});

test("parseRecents takes the header's I= or aI= component when the block has no cmp=", () => {
  expect(parseRecents("  * Recent #0: Task{1 #3 type=standard I=com.example.camera/.CameraActivity U=0}\n")).toEqual(["com.example.camera"]);
  expect(parseRecents("  * Recent #0: Task{1 #3 type=standard aI=com.example.music/.PlayerActivity U=0}\n")).toEqual(["com.example.music"]);
});

test("parseRecents skips a package that is not a package name", () => {
  expect(parseRecents("  * Recent #0: Task{1 #3 A=10:com..x U=0}\n  * Recent #1: Task{2 #4 A=11:com.example.ok U=0}\n")).toEqual(["com.example.ok"]);
});

test("parseRecents reads nothing from text without Recent blocks", () => {
  expect(parseRecents("")).toEqual([]);
  expect(parseRecents("  Visible recent tasks (most recent first):\n    baseIntent=Intent { cmp=com.example.chat/.MainActivity }\n")).toEqual([]);
});

test("parseRecents takes an A= affinity without a uid, as older releases print it", () => {
  expect(parseRecents("  * Recent #0: TaskRecord{1 #3 A=com.example.old U=0 StackId=1 sz=1}\n")).toEqual(["com.example.old"]);
});

test("parseLauncherActivities lists each package with a launcher activity once, labelled by its package", () => {
  expect(parseLauncherActivities(LAUNCHERS)).toEqual([
    { pkg: "com.example.chat", label: "com.example.chat", versionCode: null },
    { pkg: "com.example.maps", label: "com.example.maps", versionCode: null },
    { pkg: "com.android.settings", label: "com.android.settings", versionCode: null },
    { pkg: "com.example.notes", label: "com.example.notes", versionCode: null },
  ]);
});

test("parseLauncherActivities skips a package that is not a package name", () => {
  expect(parseLauncherActivities("    com..x/.A\n    com.example.ok/.Main\n").map((a) => a.pkg)).toEqual(["com.example.ok"]);
});

test("parseLauncherActivities reads nothing from No activities found", () => {
  expect(parseLauncherActivities("No activities found\n")).toEqual([]);
});
