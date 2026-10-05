import { expect, test } from "vitest";
import { BlackSampler, isBlack, SamplingTarget } from "../../src/renderer/unlock/black-sampler";
import type { FrameTarget } from "../../src/renderer/texture-renderer";

const SAMPLES = 16 * 16;

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
  const f = {} as VideoFrame;
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
