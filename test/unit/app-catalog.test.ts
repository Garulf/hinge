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

test("parseAgentIcons throws when the output is not an object", () => {
  expect(() => parseAgentIcons("[]")).toThrow();
  expect(() => parseAgentIcons("null")).toThrow();
});

test("parseRecents lists each recent task's package in order, once, from A= or else the first cmp=", () => {
  expect(parseRecents(RECENTS)).toEqual(["com.example.chat", "com.example.maps", "com.android.systemui", "com.example.notes", "com.example.browser"]);
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

test("parseLauncherActivities reads nothing from No activities found", () => {
  expect(parseLauncherActivities("No activities found\n")).toEqual([]);
});
