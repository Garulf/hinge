import { expect, test } from "vitest";
import { resolveOutputPath } from "../../src/main/output-path";

test("a bare file name lands on the desktop", () => {
  expect(resolveOutputPath("out.hrec", "/home/user/Desktop")).toBe("/home/user/Desktop/out.hrec");
});

test("a relative path with a directory part is left as given", () => {
  expect(resolveOutputPath("sub/out.hrec", "/home/user/Desktop")).toBe("sub/out.hrec");
  expect(resolveOutputPath("./sub/out.hrec", "/home/user/Desktop")).toBe("./sub/out.hrec");
});

test("an absolute path is left as given", () => {
  expect(resolveOutputPath("/tmp/out.hrec", "/home/user/Desktop")).toBe("/tmp/out.hrec");
});
