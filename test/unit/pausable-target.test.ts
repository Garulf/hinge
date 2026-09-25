import { expect, test, vi } from "vitest";
import { PausableTarget } from "../../src/renderer/pausable-target";

function frame() {
  return { close: vi.fn() } as unknown as VideoFrame & { close: ReturnType<typeof vi.fn> };
}

test("frames pass through until paused, then are closed instead of shown", () => {
  const inner = { disposed: false, setFrame: vi.fn(), end: vi.fn() };
  const target = new PausableTarget(inner);
  const first = frame();
  target.setFrame(first);
  expect(inner.setFrame).toHaveBeenCalledWith(first);

  target.paused = true;
  const held = frame();
  target.setFrame(held);
  expect(held.close).toHaveBeenCalledOnce();
  expect(inner.setFrame).toHaveBeenCalledOnce();

  target.paused = false;
  target.end();
  expect(inner.end).toHaveBeenCalledOnce();
  inner.disposed = true;
  expect(target.disposed).toBe(true);
});
