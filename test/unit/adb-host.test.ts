import { expect, test, vi } from "vitest";
import { AdbHost } from "../../src/main/adb-host";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_path: string, _args: string[], opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
    execFileCalls.push(opts);
    cb(null, "", "");
  }),
}));
const execFileCalls: unknown[] = [];

test("spawning the bundled adb hides the console window on Windows", async () => {
  execFileCalls.length = 0;
  const host = new AdbHost({ adbPath: "/x/adb", probe: { isRunning: async () => false } });
  await host.ensureServer();
  expect(execFileCalls).toEqual([{ windowsHide: true }]);
});

test("uses an already running adb server and never spawns one", async () => {
  let spawned = false;
  const host = new AdbHost({ adbPath: "/x/adb", probe: { isRunning: async () => true }, spawner: { startServer: async () => { spawned = true; } } });
  expect(await host.ensureServer()).toBe("existing");
  expect(spawned).toBe(false);
});

test("spawns the bundled adb when no server answers", async () => {
  let spawnedWith = "";
  const host = new AdbHost({ adbPath: "/x/adb", probe: { isRunning: async () => false }, spawner: { startServer: async (p) => { spawnedWith = p; } } });
  expect(await host.ensureServer()).toBe("spawned");
  expect(spawnedWith).toBe("/x/adb");
});

function hostWithAdb(getProp: () => Promise<string>, identifyTimeoutMs?: number) {
  const host = new AdbHost({ adbPath: "/x/adb", probe: { isRunning: async () => true }, identifyTimeoutMs });
  const log = { opened: [] as string[], closed: 0 };
  host.open = async (serial: string) => {
    log.opened.push(serial);
    return { getProp: async (key: string) => (key === "ro.serialno" ? getProp() : ""), close: async () => { log.closed++; } } as never;
  };
  return { host, log };
}

test("identify reads ro.serialno over the given transport and closes it again", async () => {
  const { host, log } = hostWithAdb(async () => "R5CY1234ABC");
  expect(await host.identify("10.0.0.5:40111")).toBe("R5CY1234ABC");
  expect(log).toEqual({ opened: ["10.0.0.5:40111"], closed: 1 });
});

test("identify gives null for an empty ro.serialno and for a shell that never answers", async () => {
  expect(await hostWithAdb(async () => "").host.identify("S")).toBeNull();
  const hung = hostWithAdb(() => new Promise<string>(() => {}), 20);
  expect(await hung.host.identify("S")).toBeNull();
  expect(hung.log.closed).toBe(1);
});

import { vendorPaths } from "../../src/main/vendor-paths";
test.runIf(process.env.HINGE_ADB_IT === "1")("talks to a real adb server", async () => {
  const { adb } = vendorPaths({ packaged: false, resourcesPath: "", appRoot: process.cwd(), platform: process.platform });
  const host = new AdbHost({ adbPath: adb });
  await host.ensureServer();
  const lists: unknown[] = [];
  const dispose = await host.watch((d) => lists.push(d));
  await dispose();
  expect(lists.length).toBeGreaterThanOrEqual(1);
});
