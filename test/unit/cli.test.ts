import { expect, test } from "vitest";
import { parseArgs, reportStartupError } from "../../src/main/cli";

test("defaults to run mode", () => expect(parseArgs([])).toEqual({ mode: "run", serial: null, replay: null, record: null, userData: null, dryRunTransfers: false }));
test("replay and serial", () => expect(parseArgs(["--replay", "a.hrec", "--serial", "X"])).toMatchObject({ mode: "run", serial: "X", replay: "a.hrec", record: null }));
test("a separate settings folder and dry-run transfers, for tests", () =>
  expect(parseArgs(["--replay", "a.hrec", "--user-data", "/tmp/h", "--dry-run-transfers"])).toMatchObject({ userData: "/tmp/h", dryRunTransfers: true }));
test("record", () => expect(parseArgs(["--record", "out.hrec"])).toMatchObject({ mode: "run", record: "out.hrec" }));
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
