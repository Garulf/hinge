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

interface CountingFrame {
  closes: number;
  close(): void;
  clone(): CountingFrame;
}

function countingFrame(made: CountingFrame[]): CountingFrame {
  const f: CountingFrame = {
    closes: 0,
    close() {
      f.closes += 1;
    },
    clone() {
      return countingFrame(made);
    },
  };
  made.push(f);
  return f;
}

function frames() {
  const made: CountingFrame[] = [];
  return { made, next: () => asFrame(countingFrame(made) as unknown as { closed: boolean; close(): void }) };
}

function expectEachClosedOnce(made: CountingFrame[]): void {
  expect(made.map((f) => f.closes)).toEqual(made.map(() => 1));
}

test("normal playback: every frame is closed exactly once", () => {
  const { made, next } = frames();
  const life = new FrameLifecycle(vi.fn());

  life.setFrame(next());
  life.onRendered();
  life.setFrame(next());
  life.setFrame(next());
  life.onRendered();
  life.end();

  expect(made).toHaveLength(3);
  expectEachClosedOnce(made);
});

test("handoff: the clone outlives the frame it was taken from and closes once when released", () => {
  const { made, next } = frames();
  const life = new FrameLifecycle(vi.fn());

  life.setFrame(next());
  life.onRendered();
  const clone = life.holdClone("cover");
  expect(clone).not.toBeNull();
  life.setFrame(next());
  expect(made[0].closes).toBe(1);
  expect(made[2].closes).toBe(0);

  life.releaseClone("cover");
  life.releaseClone("cover");
  life.onRendered();
  life.end();

  expect(made).toHaveLength(3);
  expectEachClosedOnce(made);
});

test("a handoff interrupted by another handoff closes every clone exactly once", () => {
  const { made, next } = frames();
  const life = new FrameLifecycle(vi.fn());

  life.setFrame(next());
  life.onRendered();
  life.holdClone("cover");
  life.setFrame(next());
  life.onRendered();
  // The phone closes again mid-fade: cover is lit again (its clone is
  // dropped) and inner now fades from a clone of its own last frame.
  life.releaseClone("cover");
  life.holdClone("inner");
  life.setFrame(next());
  // Yet another reversal before inner's fade ends replaces nothing twice.
  life.holdClone("cover");
  life.holdClone("cover");
  life.releaseClone("inner");
  life.end();
  life.releaseClone("cover");

  expectEachClosedOnce(made);
});

test("the stream ending during a fade closes the current frame but keeps the clone until released", () => {
  const { made, next } = frames();
  const render = vi.fn();
  const life = new FrameLifecycle(render);

  life.setFrame(next());
  life.onRendered();
  life.holdClone("inner");
  life.end();

  expect(made[0].closes).toBe(1);
  expect(made[1].closes).toBe(0);
  expect(life.holdClone("cover")).toBeNull();

  life.releaseClone("inner");
  expectEachClosedOnce(made);
});

test("dispose() closes the current frame and every held clone", () => {
  const { made, next } = frames();
  const life = new FrameLifecycle(vi.fn());

  life.setFrame(next());
  life.onRendered();
  life.holdClone("cover");
  life.holdClone("inner");
  life.dispose();
  life.dispose();

  expect(made).toHaveLength(3);
  expectEachClosedOnce(made);
});
