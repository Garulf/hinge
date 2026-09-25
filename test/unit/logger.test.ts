import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createLogger } from "../../src/main/logger";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hinge-logger-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("creates the log directory and truncates any previous run's file", () => {
  const path = join(dir, "nested", "hinge.log");
  const logger = createLogger(path);
  logger.log("first line");
  expect(readFileSync(path, "utf8")).toMatch(/first line\n$/);
});

test("truncates at creation even if a file from a previous run already exists", () => {
  const path = join(dir, "hinge.log");
  writeFileSync(path, "stale run\n");
  const logger = createLogger(path);
  expect(readFileSync(path, "utf8")).toBe("");
  logger.log("new run");
  expect(readFileSync(path, "utf8")).toMatch(/new run\n$/);
});

test("log() never throws even when the path is not writable", () => {
  const logger = createLogger("/does/not/exist/hinge.log");
  expect(() => logger.log("anything")).not.toThrow();
  expect(existsSync("/does/not/exist/hinge.log")).toBe(false);
});
