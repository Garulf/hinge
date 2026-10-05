import { afterEach, expect, test, vi } from "vitest";
import { BlackSampler, isBlack, SamplingTarget } from "../../src/renderer/unlock/black-sampler";
import type { FrameTarget } from "../../src/renderer/texture-renderer";

const SAMPLES = 16 * 16;

afterEach(() => vi.useRealTimers());

/** A frame that records its clones and which of them were closed. */
function fakeFrame() {
  const clones: { closed: boolean }[] = [];
  const frame = {
    clone: () => {
      const clone = { closed: false, clone: () => frame.clone(), close() { this.closed = true; } };
      clones.push(clone);
      return clone;
    },
    close() {},
  } as unknown as VideoFrame;
  return { frame, clones };
}

function frame(dark: number, lit: [number, number, number] = [255, 255, 255], darkValue = 0): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(SAMPLES * 4);
  for (let i = 0; i < SAMPLES; i++) {
    const [r, g, b] = i < dark ? [darkValue, darkValue, darkValue] : lit;
    rgba.set([r, g, b, 255], i * 4);
  }
  return rgba;
}

test("an all-black frame is black, a lit one is not", () => {
  expect(isBlack(frame(SAMPLES))).toBe(true);
  expect(isBlack(frame(0))).toBe(false);
});

test("a status bar and navigation pill over a black keyguard still count as black", () => {
  expect(isBlack(frame(SAMPLES - 20))).toBe(true);
});

test("a dark grey that is not black does not count, nor does a mostly dark app", () => {
  expect(isBlack(frame(SAMPLES, [0, 0, 0], 40))).toBe(false);
  expect(isBlack(frame(Math.floor(SAMPLES * 0.85)))).toBe(false);
});

test("the sampler reads at most every 500 ms and reports only changes", () => {
  let now = 0;
  let next = frame(SAMPLES);
  const changes: boolean[] = [];
  let reads = 0;
  const sampler = new BlackSampler({ read: () => (reads++, next), now: () => now, onChange: (b) => changes.push(b) });
  const f = fakeFrame().frame;
  sampler.offer(f);
  now = 100;
  sampler.offer(f);
  expect(reads).toBe(1);
  now = 600;
  sampler.offer(f);
  next = frame(0);
  now = 1200;
  sampler.offer(f);
  expect(changes).toEqual([true, false]);
  sampler.reset();
  now = 1250;
  sampler.offer(f);
  expect(changes).toEqual([true, false, false]);
});

test("a frame skipped inside the window is read when the window ends", () => {
  vi.useFakeTimers();
  let now = 0;
  let next = frame(0);
  const changes: boolean[] = [];
  const reads: unknown[] = [];
  const sampler = new BlackSampler({ read: (f) => (reads.push(f), next), now: () => now, onChange: (b) => changes.push(b) });
  const { frame: first } = fakeFrame();
  const { frame: settled, clones } = fakeFrame();
  sampler.offer(first);
  expect(changes).toEqual([false]);
  next = frame(SAMPLES);
  now = 100;
  sampler.offer(settled);
  expect(changes).toEqual([false]);
  now = 500;
  vi.advanceTimersByTime(400);
  expect(changes).toEqual([false, true]);
  expect(reads[1]).toBe(clones[0]);
  expect(clones[0].closed).toBe(true);
});

test("a kept frame replaced by a later one is closed, and reset closes the one still pending", () => {
  vi.useFakeTimers();
  let now = 0;
  const sampler = new BlackSampler({ read: () => frame(SAMPLES), now: () => now, onChange: () => {} });
  sampler.offer(fakeFrame().frame);
  const { frame: a, clones: first } = fakeFrame();
  const { frame: b, clones: second } = fakeFrame();
  now = 100;
  sampler.offer(a);
  now = 200;
  sampler.offer(b);
  expect(first[0].closed).toBe(true);
  expect(second[0].closed).toBe(false);
  sampler.reset();
  expect(second[0].closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("a frame read in time supersedes the kept one", () => {
  vi.useFakeTimers();
  let now = 0;
  const changes: boolean[] = [];
  const sampler = new BlackSampler({ read: () => frame(SAMPLES), now: () => now, onChange: (b) => changes.push(b) });
  sampler.offer(fakeFrame().frame);
  const { frame: kept, clones } = fakeFrame();
  now = 100;
  sampler.offer(kept);
  now = 600;
  sampler.offer(fakeFrame().frame);
  expect(clones[0].closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("a frame that cannot be read is skipped", () => {
  const changes: boolean[] = [];
  const sampler = new BlackSampler({ read: () => { throw new Error("detached"); }, now: () => 0, onChange: (b) => changes.push(b) });
  sampler.offer({} as VideoFrame);
  expect(changes).toEqual([]);
});

test("SamplingTarget samples each frame before handing it on unchanged", () => {
  const order: string[] = [];
  const inner: FrameTarget = { disposed: false, setFrame: (_f, first) => order.push(`set:${first}`), end: () => order.push("end") };
  const target = new SamplingTarget(inner, { offer: () => order.push("offer") });
  target.setFrame({} as VideoFrame, true);
  target.end();
  expect(order).toEqual(["offer", "set:true", "end"]);
  expect(target.disposed).toBe(false);
});
