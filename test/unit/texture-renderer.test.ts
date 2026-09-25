import { expect, test } from "vitest";
import { TextureFrameRenderer } from "../../src/renderer/texture-renderer";

function fakeFrame() {
  const f = { closed: false, close() { f.closed = true; } };
  return f;
}

test("hands frames to the target and closes the previous one", async () => {
  const seen: unknown[] = [];
  const r = new TextureFrameRenderer({ disposed: false, setFrame: (f) => seen.push(f) });
  const w = r.writable.getWriter();
  const a = fakeFrame(), b = fakeFrame();
  await w.write(a as unknown as VideoFrame);
  await w.write(b as unknown as VideoFrame);
  expect(seen).toEqual([a, b]);
  expect(a.closed).toBe(true);
  expect(b.closed).toBe(false);
  expect(r.framesRendered).toBe(2);
});

test("closes frames immediately once the target is disposed", async () => {
  const target = { disposed: true, setFrame: () => { throw new Error("must not be called"); } };
  const r = new TextureFrameRenderer(target);
  const f = fakeFrame();
  await r.writable.getWriter().write(f as unknown as VideoFrame);
  expect(f.closed).toBe(true);
});

test("closing the stream closes the last held frame", async () => {
  const r = new TextureFrameRenderer({ disposed: false, setFrame: () => {} });
  const w = r.writable.getWriter();
  const f = fakeFrame();
  await w.write(f as unknown as VideoFrame);
  await w.close();
  expect(f.closed).toBe(true);
});
