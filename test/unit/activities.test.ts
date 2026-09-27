import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { currentAppPackage, homePackages, resumedByDisplay, resumedOnPhoneScreen, stayedOnPhoneScreen } from "../../src/shared/activities";

// The *-aosp.txt fixture is written from the AOSP dump format, not captured from a real phone.
const ACTIVITIES = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-activity-activities-aosp.txt"), "utf8");

function dump(displays: Record<number, string[]>): string {
  return Object.entries(displays)
    .map(([id, lines]) => [`Display #${id} (activities from top to bottom):`, ...lines.map((l) => `    ${l}`)].join("\n"))
    .join("\n\n");
}

const resumed = (pkg: string, task = 7): string => `mResumedActivity: ActivityRecord{abc123 u0 ${pkg}/.Main t${task}}`;

test("each display's resumed package is read from its own section, and the global ResumedActivity line is not taken for display 0", () => {
  expect(resumedByDisplay(ACTIVITIES)).toEqual(
    new Map([
      [2, "com.example.maps"],
      [0, "com.example.chat"],
    ]),
  );
});

test("topResumedActivity= and Resumed: lines count too, and the first resumed activity in a section wins", () => {
  const text = dump({
    0: ["topResumedActivity=ActivityRecord{1 u0 com.a.top/.A t3}", resumed("com.a.second")],
    3: ["Resumed: ActivityRecord{2 u10 com.b.work/com.b.work.Main t9}"],
  });
  expect(resumedByDisplay(text)).toEqual(
    new Map([
      [0, "com.a.top"],
      [3, "com.b.work"],
    ]),
  );
});

test("a null resumed activity, a paused one and an empty dump give no package", () => {
  expect(resumedByDisplay(dump({ 0: ["mResumedActivity: null", "mLastPausedActivity: ActivityRecord{1 u0 com.a/.A t3}"] }))).toEqual(new Map());
  expect(resumedByDisplay("")).toEqual(new Map());
});

test("the launcher is found from its home task", () => {
  expect(homePackages(ACTIVITIES)).toEqual(new Set(["com.android.launcher3"]));
});

test("the current app is display 0's resumed package", () => {
  expect(currentAppPackage(ACTIVITIES)).toBe("com.example.chat");
});

test("the launcher, Samsung's launcher and System UI are never the current app", () => {
  const home = ACTIVITIES.replace(/mResumedActivity: ActivityRecord\{5d6e7f8 u0 com\.example\.chat/, "mResumedActivity: ActivityRecord{5d6e7f8 u0 com.android.launcher3").replace(
    /topResumedActivity=ActivityRecord\{5d6e7f8 u0 com\.example\.chat/,
    "topResumedActivity=ActivityRecord{5d6e7f8 u0 com.android.launcher3",
  );
  expect(currentAppPackage(home)).toBeNull();
  expect(currentAppPackage(dump({ 0: [resumed("com.sec.android.app.launcher")] }))).toBeNull();
  expect(currentAppPackage(dump({ 0: [resumed("com.android.systemui")] }))).toBeNull();
  expect(currentAppPackage(dump({ 2: [resumed("com.example.maps")] }))).toBeNull();
});

test("an app stayed on the phone screen when it is resumed on display 0 and on no other display", () => {
  expect(stayedOnPhoneScreen(dump({ 0: [resumed("com.a")] }), "com.a")).toBe(true);
  expect(stayedOnPhoneScreen(dump({ 0: [resumed("com.a")], 2: [resumed("com.a", 8)] }), "com.a")).toBe(false);
  expect(stayedOnPhoneScreen(dump({ 0: [resumed("com.launcher")], 2: [resumed("com.a")] }), "com.a")).toBe(false);
});

test("an app is resumed on the phone screen when display 0 shows it, whatever the other displays show", () => {
  expect(resumedOnPhoneScreen(dump({ 0: [resumed("com.a")], 2: [resumed("com.a", 8)] }), "com.a")).toBe(true);
  expect(resumedOnPhoneScreen(ACTIVITIES, "com.example.maps")).toBe(false);
});
