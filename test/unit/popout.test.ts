import { expect, test, vi } from "vitest";
import { displayGeometry, initialContentSize, popoutAllows, ResizeDebouncer } from "../../src/shared/popout";

test("display size is the content size in device pixels, rounded down to a multiple of 8, at 160 dpi per unit of scale", () => {
  expect(displayGeometry(400, 860, 1)).toEqual({ width: 400, height: 856, dpi: 160 });
  expect(displayGeometry(401, 861, 1.5)).toEqual({ width: 600, height: 1288, dpi: 240 });
});

test("a tiny window never makes a display smaller than 128 px a side", () => {
  expect(displayGeometry(20, 30, 1)).toEqual({ width: 128, height: 128, dpi: 160 });
});

test("a zero-sized report (a minimised window) gives no geometry", () => {
  expect(displayGeometry(0, 800, 1)).toBeNull();
  expect(displayGeometry(400, 0, 2)).toBeNull();
});

test("the first open is cover-screen shaped at 85 percent of the work area height", () => {
  expect(initialContentSize({ width: 1920, height: 1040 })).toEqual({ width: 379, height: 884 });
});

test("the debouncer fires once, 150 ms after the last push, and not again for the same geometry", () => {
  vi.useFakeTimers();
  const fired: unknown[] = [];
  const d = new ResizeDebouncer(150, (g) => fired.push(g));
  d.push({ width: 400, height: 800, dpi: 160 });
  vi.advanceTimersByTime(100);
  d.push({ width: 480, height: 800, dpi: 160 });
  vi.advanceTimersByTime(149);
  expect(fired).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(fired).toEqual([{ width: 480, height: 800, dpi: 160 }]);
  d.push({ width: 480, height: 800, dpi: 160 });
  vi.advanceTimersByTime(200);
  expect(fired).toHaveLength(1);
  d.push(null);
  vi.advanceTimersByTime(200);
  expect(fired).toHaveLength(1);
  vi.useRealTimers();
});

test("cancel drops a pending resize", () => {
  vi.useFakeTimers();
  const fired: unknown[] = [];
  const d = new ResizeDebouncer(150, (g) => fired.push(g));
  d.push({ width: 400, height: 800, dpi: 160 });
  d.cancel();
  vi.advanceTimersByTime(500);
  expect(fired).toEqual([]);
  vi.useRealTimers();
});

test("a primed geometry counts as already fired", () => {
  vi.useFakeTimers();
  const fired: unknown[] = [];
  const d = new ResizeDebouncer(150, (g) => fired.push(g));
  d.prime({ width: 400, height: 856, dpi: 160 });
  d.push({ width: 400, height: 856, dpi: 160 });
  vi.advanceTimersByTime(500);
  expect(fired).toEqual([]);
  vi.useRealTimers();
});

test("pop-outs keep only per-app shortcuts", () => {
  expect(popoutAllows("KeyB", false)).toBe(true);
  expect(popoutAllows("Backspace", false)).toBe(true);
  expect(popoutAllows("KeyC", false)).toBe(true);
  expect(popoutAllows("KeyX", false)).toBe(true);
  expect(popoutAllows("KeyV", false)).toBe(true);
  expect(popoutAllows("KeyV", true)).toBe(true);
  expect(popoutAllows("ArrowUp", false)).toBe(true);
  expect(popoutAllows("ArrowDown", false)).toBe(true);
  expect(popoutAllows("KeyR", true)).toBe(true);
  expect(popoutAllows("KeyR", false)).toBe(false);
  expect(popoutAllows("KeyH", false)).toBe(false);
  expect(popoutAllows("KeyS", false)).toBe(false);
  expect(popoutAllows("KeyN", false)).toBe(false);
  expect(popoutAllows("KeyD", false)).toBe(false);
  expect(popoutAllows("KeyT", false)).toBe(false);
});
