import { expect, test, vi } from "vitest";
import { FrameLifecycle } from "../../src/renderer/scene/frame-lifecycle";

function fakeFrame() {
  const f = { closed: false, close() { f.closed = true; } };
  return f;
}

function asFrame(f: { closed: boolean; close(): void }): VideoFrame {
  return f as unknown as VideoFrame;
}

test("a frame superseded before any render tick closes immediately", () => {
  const render = vi.fn();
  const life = new FrameLifecycle(render);
  const a = fakeFrame();
  const b = fakeFrame();

  life.setFrame(asFrame(a));
  life.setFrame(asFrame(b));

  expect(a.closed).toBe(true);
  expect(b.closed).toBe(false);
  expect(render).not.toHaveBeenCalled();
});

test("the current frame is not closed by end() until it has actually been uploaded", () => {
  const render = vi.fn();
  const life = new FrameLifecycle(render);
  const a = fakeFrame();

  life.setFrame(asFrame(a));
  life.onRendered(); // simulates a render tick that uploaded `a`
  life.end();

  expect(render).not.toHaveBeenCalled(); // already uploaded, no forced re-render needed
  expect(a.closed).toBe(true);
});

test("end() forces one last render before closing a frame that was never uploaded", () => {
  const render = vi.fn();
  const life = new FrameLifecycle(render);
  const a = fakeFrame();

  life.setFrame(asFrame(a)); // no render tick has happened yet
  life.end();

  expect(render).toHaveBeenCalledOnce();
  expect(a.closed).toBe(true);
});

test("end() with no current frame does not render", () => {
  const render = vi.fn();
  const life = new FrameLifecycle(render);

  life.end();

  expect(render).not.toHaveBeenCalled();
});

test("end() is safe to call twice", () => {
  const render = vi.fn();
  const life = new FrameLifecycle(render);
  const a = fakeFrame();

  life.setFrame(asFrame(a));
  life.end();
  life.end();

  expect(render).toHaveBeenCalledOnce();
});
