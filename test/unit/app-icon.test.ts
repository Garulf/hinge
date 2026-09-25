import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { appIconPath } from "../../src/main/app-icon";

test("the window icon resolves from the built main script to build/icon.png, which the packaged files include", () => {
  const fromOut = appIconPath(resolve("out/main"));
  expect(fromOut).toBe(resolve("build/icon.png"));
  expect(existsSync(fromOut)).toBe(true);
  const filesLine = readFileSync(resolve("electron-builder.yml"), "utf8").split("\n").find((line) => line.startsWith("files:"));
  expect(filesLine).toContain('"build/icon.png"');
});
