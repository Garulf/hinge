import { expect, test } from "vitest";
import { appFromArgv, launchRequest, parseArgs, reportStartupError } from "../../src/main/cli";

test("defaults to run mode", () => expect(parseArgs([])).toEqual({ mode: "run", serial: null, replay: null, record: null, userData: null, dryRunTransfers: false, app: null }));
test("replay and serial", () => expect(parseArgs(["--replay", "a.hrec", "--serial", "X"])).toMatchObject({ mode: "run", serial: "X", replay: "a.hrec", record: null }));
test("a separate settings folder and dry-run transfers, for tests", () =>
  expect(parseArgs(["--replay", "a.hrec", "--user-data", "/tmp/h", "--dry-run-transfers"])).toMatchObject({ userData: "/tmp/h", dryRunTransfers: true }));
test("record", () => expect(parseArgs(["--record", "out.hrec"])).toMatchObject({ mode: "run", record: "out.hrec" }));
test("an app to pop out", () => expect(parseArgs(["--app", "com.example.chat"])).toMatchObject({ mode: "run", app: "com.example.chat" }));
test("the app from a second launch's argv, among Electron and Chromium switches", () =>
  expect(appFromArgv(["/opt/hinge/hinge", "--no-sandbox", "--app", "com.x", "--allow-file-access"])).toBe("com.x"));
test("the app in its --app=pkg form", () => expect(appFromArgv(["/opt/hinge/hinge", "--app=com.x"])).toBe("com.x"));
test("no app in a plain second launch, or one whose --app has no package", () => {
  expect(appFromArgv(["/opt/hinge/hinge", "--no-sandbox"])).toBeNull();
  expect(appFromArgv(["/opt/hinge/hinge", "--app"])).toBeNull();
  expect(appFromArgv(["/opt/hinge/hinge", "--app", "--no-sandbox"])).toBeNull();
});
test("a second launch's app comes from the lock's additional data, whatever order its argv arrives in", () => {
  expect(launchRequest({ app: "com.x" }, ["/opt/hinge/hinge", "com.y", "--app"])).toBe("com.x");
  expect(launchRequest({ app: null }, ["/opt/hinge/hinge", "--app", "com.y"])).toBeNull();
});
test("without additional data a second launch falls back to its argv", () => {
  expect(launchRequest(undefined, ["/opt/hinge/hinge", "--app", "com.y"])).toBe("com.y");
  expect(launchRequest({ other: 1 }, ["/opt/hinge/hinge"])).toBeNull();
  expect(launchRequest({ app: 5 }, ["/opt/hinge/hinge", "--app", "com.y"])).toBe("com.y");
});
test("probe with defaults", () => expect(parseArgs(["--probe"])).toEqual({ mode: "probe", serial: null, seconds: 90, out: null }));
test("probe with seconds and out", () => expect(parseArgs(["--probe", "--seconds", "30", "--out", "r.json"])).toEqual({ mode: "probe", serial: null, seconds: 30, out: "r.json" }));
test("ignores electron and chromium switches", () => expect(parseArgs(["--no-sandbox", "--enable-logging", "."]).mode).toBe("run"));
test("rejects a missing --seconds value", () => expect(() => parseArgs(["--probe", "--seconds"])).toThrow(/--seconds/));
test("rejects a non-numeric --seconds value", () => expect(() => parseArgs(["--probe", "--seconds", "soon"])).toThrow(/--seconds/));

test("M6: a packaged win32 build routes a startup error to a dialog", () => {
  expect(reportStartupError(new Error("bad --seconds"), { packaged: true, platform: "win32" })).toEqual({
    channel: "dialog",
    message: "Error: bad --seconds",
  });
});

test("M6: an unpackaged (dev) run uses the console even on win32", () => {
  expect(reportStartupError(new Error("bad --seconds"), { packaged: false, platform: "win32" })).toEqual({
    channel: "console",
    message: "Error: bad --seconds",
  });
});

test("M6: a packaged non-Windows build uses the console", () => {
  expect(reportStartupError(new Error("bad --seconds"), { packaged: true, platform: "linux" })).toEqual({
    channel: "console",
    message: "Error: bad --seconds",
  });
});
