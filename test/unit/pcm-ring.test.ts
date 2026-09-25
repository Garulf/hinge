import { expect, test } from "vitest";
import { PcmRing } from "../../src/shared/pcm-ring";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
// With the default policy (target 40ms, max 120ms) at 48kHz: 1 frame = 1/48 ms.
const CHUNK_FRAMES = 960; // 20ms
const TARGET_FRAMES = 1920; // 40ms
const MAX_FRAMES = 5760; // 120ms

function chunk(value: number, frames = CHUNK_FRAMES): Float32Array[] {
  return [new Float32Array(frames).fill(value), new Float32Array(frames).fill(value)];
}

test("starts silent and buffering: pull() before the 40ms target is reached returns silence and does not start playing", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, 100));
  const out = ring.pull(100);
  expect(ring.playing).toBe(false);
  expect(Array.from(out[0])).toEqual(new Array(100).fill(0));
});

test("starts playing once 40ms is buffered, and pull() returns the fed samples in order", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES));
  expect(ring.playing).toBe(false);

  const out = ring.pull(100);
  expect(ring.playing).toBe(true);
  expect(Array.from(out[0].subarray(0, 5))).toEqual([1, 1, 1, 1, 1]);
});

test("feeding far faster than real time (no pulls in between) never lets buffered frames exceed the 120ms ceiling", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  for (let i = 0; i < 40; i++) {
    ring.push(chunk(i, CHUNK_FRAMES));
    expect(ring.bufferedFrames).toBeLessThanOrEqual(MAX_FRAMES);
  }
});

test("exceeding the 120ms ceiling drops the oldest samples down to the 40ms target", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  // 6 chunks of 20ms = 120ms exactly: at the ceiling, not yet over.
  for (let i = 0; i < 6; i++) ring.push(chunk(i, CHUNK_FRAMES));
  expect(ring.bufferedFrames).toBe(MAX_FRAMES);

  // One more chunk pushes past the ceiling: oldest chunks (0, 1, ...) must be
  // dropped until buffered is back down near the 40ms target.
  ring.push(chunk(6, CHUNK_FRAMES));
  expect(ring.bufferedFrames).toBeLessThanOrEqual(TARGET_FRAMES + CHUNK_FRAMES);
  expect(ring.bufferedFrames).toBeGreaterThan(0);

  // What survives is the newest audio (chunk 6, and whatever chunk(s) just
  // before it fit), not the oldest (chunk 0 must be gone).
  const out = ring.pull(1);
  expect(out[0][0]).not.toBe(0);
  expect(out[0][0]).toBeGreaterThan(0); // chunk 0's value was 0; a later chunk's value survives
});

test("real playback pulling at the correct rate drains buffered audio back toward empty instead of it staying pinned high", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES * 2)); // 80ms buffered, well past the 40ms start threshold
  ring.pull(1); // crosses into "playing"
  expect(ring.bufferedFrames).toBeGreaterThan(0);

  // Pull everything that's buffered.
  const remaining = ring.bufferedFrames;
  ring.pull(remaining);
  expect(ring.bufferedFrames).toBe(0);
});

test("underrun (pulling more than is buffered) outputs silence for the shortfall and returns to buffering, requiring 40ms again before playing resumes", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES));
  ring.pull(1); // starts playing
  expect(ring.playing).toBe(true);

  const out = ring.pull(TARGET_FRAMES); // only TARGET_FRAMES - 1 left buffered: this underruns
  expect(ring.playing).toBe(false);
  expect(out[0][out[0].length - 1]).toBe(0); // the shortfall is silence

  // Buffering again: less than 40ms is not enough to resume playing.
  ring.push(chunk(2, TARGET_FRAMES - 100));
  const stillSilent = ring.pull(10);
  expect(ring.playing).toBe(false);
  expect(Array.from(stillSilent[0])).toEqual(new Array(10).fill(0));

  // Reaching 40ms again resumes playback.
  ring.push(chunk(2, 200));
  const resumed = ring.pull(10);
  expect(ring.playing).toBe(true);
  expect(resumed[0][0]).toBe(2);
});

test("a chunk is split across multiple pulls correctly, preserving sample order", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  const first = new Float32Array(TARGET_FRAMES);
  for (let i = 0; i < TARGET_FRAMES; i++) first[i] = i;
  ring.push([first, first.slice()]);

  const a = ring.pull(TARGET_FRAMES / 2);
  const b = ring.pull(TARGET_FRAMES / 2);
  expect(a[0][0]).toBe(0);
  expect(a[0][a[0].length - 1]).toBe(TARGET_FRAMES / 2 - 1);
  expect(b[0][0]).toBe(TARGET_FRAMES / 2);
  expect(b[0][b[0].length - 1]).toBe(TARGET_FRAMES - 1);
});

test("reset() clears buffered audio and returns to buffering", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES));
  ring.pull(1);
  expect(ring.playing).toBe(true);

  ring.reset();
  expect(ring.bufferedFrames).toBe(0);
  expect(ring.playing).toBe(false);
  const out = ring.pull(10);
  expect(Array.from(out[0])).toEqual(new Array(10).fill(0));
});

test("a custom target/max policy is honoured", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS, { targetMs: 10, maxMs: 30 });
  const targetFrames = 480;
  const maxFrames = 1440;
  ring.push(chunk(1, targetFrames - 1));
  expect(ring.playing).toBe(false);
  ring.pull(0);
  ring.push(chunk(1, 1));
  ring.pull(1);
  expect(ring.playing).toBe(true);

  ring.push(chunk(1, maxFrames));
  expect(ring.bufferedFrames).toBeLessThanOrEqual(maxFrames);
});
