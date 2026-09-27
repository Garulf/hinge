import { expect, test } from "vitest";
import { restoreBounds } from "../../src/shared/popout-bounds";

const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: -200, width: 2560, height: 1400 };

test("nothing saved gives null, so the default size is used", () => {
  expect(restoreBounds(undefined, [LEFT])).toBeNull();
});

test("a window saved on either monitor comes back where it was", () => {
  expect(restoreBounds({ x: 100, y: 50, width: 400, height: 900 }, [LEFT, RIGHT])).toEqual({ x: 100, y: 50, width: 400, height: 900 });
  expect(restoreBounds({ x: 2000, y: -100, width: 400, height: 900 }, [LEFT, RIGHT])).toEqual({ x: 2000, y: -100, width: 400, height: 900 });
});

test("a window partly off its monitor is pulled back inside the work area it overlaps most", () => {
  expect(restoreBounds({ x: 1700, y: 300, width: 400, height: 900 }, [LEFT])).toEqual({ x: 1520, y: 140, width: 400, height: 900 });
  expect(restoreBounds({ x: 1800, y: 0, width: 400, height: 900 }, [LEFT, RIGHT])).toEqual({ x: 1920, y: 0, width: 400, height: 900 });
});

test("a window bigger than the work area it lands on shrinks to fit it", () => {
  expect(restoreBounds({ x: 10, y: 10, width: 1000, height: 1300 }, [LEFT])).toEqual({ x: 10, y: 0, width: 1000, height: 1040 });
});

test("a window whose monitor is gone gives null", () => {
  expect(restoreBounds({ x: 2000, y: 100, width: 400, height: 900 }, [LEFT])).toBeNull();
  expect(restoreBounds({ x: 100, y: 50, width: 400, height: 900 }, [])).toBeNull();
});
