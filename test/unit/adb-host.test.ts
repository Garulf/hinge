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
