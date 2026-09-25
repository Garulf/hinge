import { expect, test, vi } from "vitest";
import { TextureFrameRenderer } from "../../src/renderer/texture-renderer";

function fakeFrame() {
  const f = { closed: false, close() { f.closed = true; } };
  return f;
}

// Frame ownership (closing) belongs to the target (PhoneScene / FrameLifecycle,
// see findings I3): TextureFrameRenderer only hands frames off and reports
// end of stream, it never closes a frame itself.

test("hands every frame to the target without closing any of them itself", async () => {
  const seen: unknown[] = [];
  const r = new TextureFrameRenderer({ disposed: false, setFrame: (f) => seen.push(f), end: () => {} });
  const w = r.writable.getWriter();
  const a = fakeFrame(), b = fakeFrame();
  await w.write(a as unknown as VideoFrame);
  await w.write(b as unknown as VideoFrame);
  expect(seen).toEqual([a, b]);
  expect(a.closed).toBe(false);
  expect(b.closed).toBe(false);
  expect(r.framesRendered).toBe(2);
});

test("closes frames immediately once the target is disposed, without calling setFrame", async () => {
  const target = { disposed: true, setFrame: () => { throw new Error("must not be called"); }, end: () => {} };
  const r = new TextureFrameRenderer(target);
  const f = fakeFrame();
  await r.writable.getWriter().write(f as unknown as VideoFrame);
  expect(f.closed).toBe(true);
});

test("closing or aborting the stream calls the target's end()", async () => {
  const end = vi.fn();
  const r = new TextureFrameRenderer({ disposed: false, setFrame: () => {}, end });
  const w = r.writable.getWriter();
  const f = fakeFrame();
  await w.write(f as unknown as VideoFrame);
  await w.close();
  expect(end).toHaveBeenCalledOnce();
});
