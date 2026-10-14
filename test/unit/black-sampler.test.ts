import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BlackSampler, frameReader, gridSample, isBlack, SamplingTarget } from "../../src/renderer/unlock/black-sampler";
import type { FrameTarget } from "../../src/renderer/texture-renderer";

const SAMPLES = 16 * 16;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);

/** A frame that records its clones and how often each was closed. */
function fakeFrame() {
  const clones: { closes: number }[] = [];
  const frame = {
    clone: () => {
      const clone = { closes: 0, clone: () => frame.clone(), close() { this.closes++; } };
      clones.push(clone);
      return clone;
    },
    close() {},
  } as unknown as VideoFrame;
  return { frame, clones };
}

/** A read the test settles by hand, one call at a time. */
function manualRead() {
  const calls: { frame: VideoFrame; resolve(rgba: Uint8ClampedArray): void; reject(error: Error): void }[] = [];
  const read = (frame: VideoFrame) =>
    new Promise<Uint8ClampedArray>((resolve, reject) => calls.push({ frame, resolve, reject }));
  return { read, calls };
}

function splitImage(width: number, height: number, litAt: (x: number, y: number) => boolean): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(litAt(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * width + x) * 4);
  }
  return rgba;
}

const darkSamples = (rgba: Uint8ClampedArray) => rgba.length / 4 - Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4]).filter((r) => r > 24).length;

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

test("gridSample is 16x16 RGBA and takes the pixel at the centre of each cell", () => {
  const width = 64;
  const height = 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([i % 251, 1, 2, 255], i * 4);
  const sample = gridSample(rgba, width, height);
  expect(sample.length).toBe(16 * 16 * 4);
  for (const [gx, gy] of [[0, 0], [5, 3], [15, 15]]) {
    const x = Math.floor(((gx + 0.5) * width) / 16);
    const y = Math.floor(((gy + 0.5) * height) / 16);
    const at = (gy * 16 + gx) * 4;
    expect(Array.from(sample.subarray(at, at + 4))).toEqual([(y * width + x) % 251, 1, 2, 255]);
  }
});

test("a frame lit on the left and black on the right samples exactly half dark", () => {
  const rgba = splitImage(100, 50, (x) => x < 50);
  const sample = gridSample(rgba, 100, 50);
  expect(darkSamples(sample)).toBe(128);
  expect(isBlack(sample)).toBe(false);
});

test("a one-row status bar of white over black still counts as black", () => {
  const sample = gridSample(splitImage(160, 320, (_x, y) => y < 20), 160, 320);
  expect(darkSamples(sample)).toBe(240);
  expect(isBlack(sample)).toBe(true);
});

test("the reader copies a clone as RGBA, reuses its buffer, and closes every clone", async () => {
  const width = 32;
  const height = 32;
  const pixels = splitImage(width, height, (x) => x < 16);
  const buffers: Uint8Array[] = [];
  const clones: { closes: number }[] = [];
  const frame = {
    clone: () => {
      const clone = {
        closes: 0,
        visibleRect: { width, height },
        allocationSize: (options: VideoFrameCopyToOptions) => (expect(options.format).toBe("RGBA"), pixels.length),
        copyTo: async (buffer: Uint8Array, options: VideoFrameCopyToOptions) => {
          expect(options.format).toBe("RGBA");
          buffers.push(buffer);
          buffer.set(pixels);
        },
        close() { this.closes++; },
      };
      clones.push(clone);
      return clone;
    },
  } as unknown as VideoFrame;
  const read = frameReader();
  const first = await read(frame);
  const second = await read(frame);
  expect(darkSamples(first)).toBe(128);
  expect(Array.from(second)).toEqual(Array.from(first));
  expect(buffers[1]).toBe(buffers[0]);
  expect(clones.map((c) => c.closes)).toEqual([1, 1]);
});

test("the reader rejects and still closes its clone when the copy fails", async () => {
  const clone = {
    closes: 0,
    visibleRect: { width: 2, height: 2 },
    allocationSize: () => 16,
    copyTo: () => Promise.reject(new Error("detached")),
    close() { this.closes++; },
  };
  const read = frameReader();
  await expect(read({ clone: () => clone } as unknown as VideoFrame)).rejects.toThrow("detached");
  expect(clone.closes).toBe(1);
});

test("the sampler reads at most every 500 ms and reports only changes", async () => {
  let now = 0;
  let next = frame(SAMPLES);
  const changes: boolean[] = [];
  let reads = 0;
  const sampler = new BlackSampler({ read: async () => (reads++, next), now: () => now, onChange: (b) => changes.push(b) });
  const f = fakeFrame().frame;
  sampler.offer(f);
  await settle();
  now = 100;
  sampler.offer(f);
  expect(reads).toBe(1);
  now = 600;
  sampler.offer(f);
  await settle();
  next = frame(0);
  now = 1200;
  sampler.offer(f);
  await settle();
  expect(changes).toEqual([true, false]);
  sampler.reset();
  now = 1250;
  sampler.offer(f);
  await settle();
  expect(changes).toEqual([true, false, false]);
});

test("a frame skipped inside the window is read when the window ends", async () => {
  let now = 0;
  let next = frame(0);
  const changes: boolean[] = [];
  const reads: unknown[] = [];
  const sampler = new BlackSampler({ read: async (f) => (reads.push(f), next), now: () => now, onChange: (b) => changes.push(b) });
  const { frame: first } = fakeFrame();
  const { frame: settled, clones } = fakeFrame();
  sampler.offer(first);
  await settle();
  expect(changes).toEqual([false]);
  next = frame(SAMPLES);
  now = 100;
  sampler.offer(settled);
  expect(changes).toEqual([false]);
  now = 500;
  await vi.advanceTimersByTimeAsync(400);
  expect(changes).toEqual([false, true]);
  expect(reads[1]).toBe(clones[0]);
  expect(clones.map((c) => c.closes)).toEqual([1]);
});

test("a kept frame replaced by a later one is closed, and reset closes the one still pending", () => {
  let now = 0;
  const sampler = new BlackSampler({ read: async () => frame(SAMPLES), now: () => now, onChange: () => {} });
  sampler.offer(fakeFrame().frame);
  const { frame: a, clones: first } = fakeFrame();
  const { frame: b, clones: second } = fakeFrame();
  now = 100;
  sampler.offer(a);
  now = 200;
  sampler.offer(b);
  expect(first[0].closes).toBe(1);
  expect(second[0].closes).toBe(0);
  sampler.reset();
  expect(second[0].closes).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a frame read in time supersedes the kept one", async () => {
  let now = 0;
  const sampler = new BlackSampler({ read: async () => frame(SAMPLES), now: () => now, onChange: () => {} });
  sampler.offer(fakeFrame().frame);
  await settle();
  const { frame: kept, clones } = fakeFrame();
  now = 100;
  sampler.offer(kept);
  now = 600;
  sampler.offer(fakeFrame().frame);
  expect(clones.map((c) => c.closes)).toEqual([1]);
  expect(vi.getTimerCount()).toBe(0);
});

test("only one read is in flight, and a frame offered meanwhile is read once it settles", async () => {
  let now = 0;
  const { read, calls } = manualRead();
  const changes: boolean[] = [];
  const sampler = new BlackSampler({ read, now: () => now, onChange: (b) => changes.push(b) });
  const first = fakeFrame();
  const offered = fakeFrame();
  sampler.offer(first.frame);
  now = 700;
  sampler.offer(offered.frame);
  now = 800;
  sampler.offer(offered.frame);
  await settle();
  expect(calls).toHaveLength(1);
  expect(offered.clones).toHaveLength(2);
  expect(offered.clones.map((c) => c.closes)).toEqual([1, 0]);
  expect(vi.getTimerCount()).toBe(0);

  calls[0].resolve(frame(SAMPLES));
  await settle();
  expect(changes).toEqual([true]);
  expect(calls).toHaveLength(2);
  expect(calls[1].frame).toBe(offered.clones[1]);
  expect(offered.clones.map((c) => c.closes)).toEqual([1, 1]);

  calls[1].resolve(frame(0));
  await settle();
  expect(changes).toEqual([true, false]);
});

test("a frame kept while a read is in flight waits out the interval after it settles", async () => {
  let now = 0;
  const { read, calls } = manualRead();
  const sampler = new BlackSampler({ read, now: () => now, onChange: () => {} });
  const kept = fakeFrame();
  sampler.offer(fakeFrame().frame);
  now = 100;
  sampler.offer(kept.frame);
  calls[0].resolve(frame(0));
  await settle();
  expect(calls).toHaveLength(1);
  now = 500;
  await vi.advanceTimersByTimeAsync(400);
  expect(calls).toHaveLength(2);
  expect(kept.clones.map((c) => c.closes)).toEqual([1]);
});

test("reset during a read discards its result and closes the pending clone", async () => {
  let now = 0;
  const { read, calls } = manualRead();
  const changes: boolean[] = [];
  const sampler = new BlackSampler({ read, now: () => now, onChange: (b) => changes.push(b) });
  const pending = fakeFrame();
  sampler.offer(fakeFrame().frame);
  now = 50;
  sampler.offer(pending.frame);
  sampler.reset();
  expect(pending.clones.map((c) => c.closes)).toEqual([1]);

  now = 60;
  sampler.offer(fakeFrame().frame);
  expect(calls).toHaveLength(2);
  calls[0].resolve(frame(SAMPLES));
  await settle();
  expect(changes).toEqual([]);
  calls[1].resolve(frame(0));
  await settle();
  expect(changes).toEqual([false]);
});

test("a rejected read is skipped, and the next frame is still read", async () => {
  let now = 0;
  const { read, calls } = manualRead();
  const changes: boolean[] = [];
  const sampler = new BlackSampler({ read, now: () => now, onChange: (b) => changes.push(b) });
  const f = fakeFrame().frame;
  sampler.offer(f);
  calls[0].reject(new Error("detached"));
  await settle();
  expect(changes).toEqual([]);
  now = 600;
  sampler.offer(f);
  calls[1].resolve(frame(SAMPLES));
  await settle();
  expect(changes).toEqual([true]);
});

test("a read that throws synchronously is skipped", async () => {
  const changes: boolean[] = [];
  const sampler = new BlackSampler({ read: () => { throw new Error("detached"); }, now: () => 0, onChange: (b) => changes.push(b) });
  sampler.offer({} as VideoFrame);
  await settle();
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
