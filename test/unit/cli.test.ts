import { expect, test } from "vitest";
import { parseArgs } from "../../src/main/cli";

test("defaults to run mode", () => expect(parseArgs([])).toEqual({ mode: "run", serial: null, replay: null, record: null }));
test("replay and serial", () => expect(parseArgs(["--replay", "a.hrec", "--serial", "X"])).toEqual({ mode: "run", serial: "X", replay: "a.hrec", record: null }));
test("record", () => expect(parseArgs(["--record", "out.hrec"])).toMatchObject({ mode: "run", record: "out.hrec" }));
test("probe with defaults", () => expect(parseArgs(["--probe"])).toEqual({ mode: "probe", serial: null, seconds: 90, out: null }));
test("probe with seconds and out", () => expect(parseArgs(["--probe", "--seconds", "30", "--out", "r.json"])).toEqual({ mode: "probe", serial: null, seconds: 30, out: "r.json" }));
test("ignores electron and chromium switches", () => expect(parseArgs(["--no-sandbox", "--enable-logging", "."]).mode).toBe("run"));
