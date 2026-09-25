import { expect, test } from "vitest";
import { TARGETS, selectTargets, keptFilesFor } from "../../scripts/fetch-vendor.mjs";

test("no --only filter keeps every target", () => {
  expect(selectTargets(TARGETS, null)).toEqual(TARGETS);
});

test("--only linux keeps the linux platform-tools target and the platform-independent one", () => {
  const picked = selectTargets(TARGETS, new Set(["linux"]));
  expect(picked.map((t) => t.file)).toEqual(["scrcpy-server-v4.1", "platform-tools_r37.0.1-linux.zip"]);
});

test("--only win keeps the win platform-tools target and the platform-independent one", () => {
  const picked = selectTargets(TARGETS, new Set(["win"]));
  expect(picked.map((t) => t.file)).toEqual(["scrcpy-server-v4.1", "platform-tools_r37.0.1-win.zip"]);
});

test("--only with an unknown platform drops every extractTo target", () => {
  const picked = selectTargets(TARGETS, new Set(["mac"]));
  expect(picked.map((t) => t.file)).toEqual(["scrcpy-server-v4.1"]);
});

test("kept files for a plain download target is just the file itself", () => {
  const target = TARGETS.find((t) => t.file === "scrcpy-server-v4.1")!;
  expect(keptFilesFor(target)).toEqual(["scrcpy-server-v4.1"]);
});

test("kept files for the linux platform-tools target excludes windows-only entries", () => {
  const target = TARGETS.find((t) => t.file === "platform-tools_r37.0.1-linux.zip")!;
  const kept = keptFilesFor(target);
  expect(kept).toContain("adb");
  expect(kept).toContain("NOTICE.txt");
  expect(kept).not.toContain("adb.exe");
  expect(kept).not.toContain("AdbWinApi.dll");
});

test("kept files for the windows platform-tools target includes the adb DLLs", () => {
  const target = TARGETS.find((t) => t.file === "platform-tools_r37.0.1-win.zip")!;
  const kept = keptFilesFor(target);
  expect(kept).toEqual(["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt"]);
});
