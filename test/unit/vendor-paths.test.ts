import { expect, test } from "vitest";
import { vendorPaths } from "../../src/main/vendor-paths";

test("dev build resolves vendor dir under the app root", () => {
  const p = vendorPaths({ packaged: false, resourcesPath: "/x", appRoot: "/repo", platform: "linux" });
  expect(p.adb).toBe("/repo/vendor/platform-tools-linux/adb");
  expect(p.scrcpyServer).toBe("/repo/vendor/scrcpy-server-v4.1");
  expect(p.agent).toBe("/repo/vendor/hinge-agent.jar");
});

test("packaged windows build resolves under resources and uses adb.exe", () => {
  const p = vendorPaths({ packaged: true, resourcesPath: "C:/app/resources", appRoot: "/ignored", platform: "win32" });
  expect(p.adb).toBe("C:/app/resources/vendor/platform-tools-win/adb.exe");
  expect(p.scrcpyServer).toBe("C:/app/resources/vendor/scrcpy-server-v4.1");
  expect(p.agent).toBe("C:/app/resources/vendor/hinge-agent.jar");
});
