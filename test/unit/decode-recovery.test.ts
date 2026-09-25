import { expect, test } from "vitest";
import { DecodeRecovery } from "../../src/shared/decode-recovery";

test("the first error asks for a video reset, a second within 5 s is shown", () => {
  const r = new DecodeRecovery();
  expect(r.onError(1000)).toBe("reset");
  expect(r.onError(5999)).toBe("show");
});

test("an error more than 5 s after the last reset asks for another reset", () => {
  const r = new DecodeRecovery();
  expect(r.onError(1000)).toBe("reset");
  expect(r.onError(6001)).toBe("reset");
  expect(r.onError(7000)).toBe("show");
});
