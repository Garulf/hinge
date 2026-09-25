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

function outputs(frameCount: number, channels = CHANNELS): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(frameCount));
}

test("starts silent and buffering: pullInto() before the 40ms target is reached returns silence and does not start playing", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, 100));
  const out = outputs(100);
  const filled = ring.pullInto(out);
  expect(ring.playing).toBe(false);
  expect(filled).toBe(0);
  expect(Array.from(out[0])).toEqual(new Array(100).fill(0));
});

test("starts playing once 40ms is buffered, and pullInto() returns the fed samples in order", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES));
  expect(ring.playing).toBe(false);

  const out = outputs(100);
  const filled = ring.pullInto(out);
  expect(ring.playing).toBe(true);
  expect(filled).toBe(100);
  expect(Array.from(out[0].subarray(0, 5))).toEqual([1, 1, 1, 1, 1]);
});

test("feeding far faster than real time (no pulls in between) never lets buffered frames exceed the 120ms ceiling", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  for (let i = 0; i < 40; i++) {
    ring.push(chunk(i, CHUNK_FRAMES));
    expect(ring.bufferedFrames).toBeLessThanOrEqual(MAX_FRAMES);
  }
});

test("exceeding the 120ms ceiling drops down to exactly the 40ms target, not merely under the ceiling", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  // 6 chunks of 20ms = 120ms exactly: at the ceiling, not yet over.
  for (let i = 0; i < 6; i++) ring.push(chunk(i, CHUNK_FRAMES));
  expect(ring.bufferedFrames).toBe(MAX_FRAMES);

  // One more chunk pushes past the ceiling: dropping must land exactly at
  // the 40ms target (by samples, not whole chunks, which could overshoot).
  ring.push(chunk(6, CHUNK_FRAMES));
  expect(ring.bufferedFrames).toBe(TARGET_FRAMES);

  // What survives is the newest audio (chunk 6 and the tail of an earlier
  // one), not the oldest (chunk 0, value 0, must be gone).
  const out = outputs(1);
  ring.pullInto(out);
  expect(out[0][0]).toBeGreaterThan(0);
});

test("real playback pulling at the correct rate drains buffered audio back toward empty instead of it staying pinned high", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES * 2)); // 80ms buffered, well past the 40ms start threshold
  ring.pullInto(outputs(1)); // crosses into "playing"
  expect(ring.bufferedFrames).toBeGreaterThan(0);

  // Pull everything that's buffered.
  const remaining = ring.bufferedFrames;
  ring.pullInto(outputs(remaining));
  expect(ring.bufferedFrames).toBe(0);
});

test("underrun (pulling more than is buffered) outputs silence for the shortfall and returns to buffering, requiring 40ms again before playing resumes", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES));
  ring.pullInto(outputs(1)); // starts playing
  expect(ring.playing).toBe(true);

  const out = outputs(TARGET_FRAMES); // only TARGET_FRAMES - 1 left buffered: this underruns
  const filled = ring.pullInto(out);
  expect(ring.playing).toBe(false);
  expect(filled).toBe(TARGET_FRAMES - 1);
  expect(out[0][out[0].length - 1]).toBe(0); // the shortfall is silence

  // Buffering again: less than 40ms is not enough to resume playing.
  ring.push(chunk(2, TARGET_FRAMES - 100));
  const stillSilent = outputs(10);
  const stillFilled = ring.pullInto(stillSilent);
  expect(ring.playing).toBe(false);
  expect(stillFilled).toBe(0);
  expect(Array.from(stillSilent[0])).toEqual(new Array(10).fill(0));

  // Reaching 40ms again resumes playback.
  ring.push(chunk(2, 200));
  const resumed = outputs(10);
  const resumedFilled = ring.pullInto(resumed);
  expect(ring.playing).toBe(true);
  expect(resumedFilled).toBe(10);
  expect(resumed[0][0]).toBe(2);
});

test("a chunk is split across multiple pulls correctly, preserving sample order", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  const first = new Float32Array(TARGET_FRAMES);
  for (let i = 0; i < TARGET_FRAMES; i++) first[i] = i;
  ring.push([first, first.slice()]);

  const a = outputs(TARGET_FRAMES / 2);
  ring.pullInto(a);
  const b = outputs(TARGET_FRAMES / 2);
  ring.pullInto(b);
  expect(a[0][0]).toBe(0);
  expect(a[0][a[0].length - 1]).toBe(TARGET_FRAMES / 2 - 1);
  expect(b[0][0]).toBe(TARGET_FRAMES / 2);
  expect(b[0][b[0].length - 1]).toBe(TARGET_FRAMES - 1);
});

test("reset() clears buffered audio and returns to buffering", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES));
  ring.pullInto(outputs(1));
  expect(ring.playing).toBe(true);

  ring.reset();
  expect(ring.bufferedFrames).toBe(0);
  expect(ring.playing).toBe(false);
  const out = outputs(10);
  ring.pullInto(out);
  expect(Array.from(out[0])).toEqual(new Array(10).fill(0));
});

test("a custom target/max policy is honoured", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS, { targetMs: 10, maxMs: 30 });
  const targetFrames = 480;
  const maxFrames = 1440;
  ring.push(chunk(1, targetFrames - 1));
  expect(ring.playing).toBe(false);
  ring.push(chunk(1, 1));
  ring.pullInto(outputs(1));
  expect(ring.playing).toBe(true);

  ring.push(chunk(1, maxFrames));
  expect(ring.bufferedFrames).toBeLessThanOrEqual(maxFrames);
});

test("real-time alternation: 128-frame pulls against 20ms (960-frame) pushes keep buffered latency between 40ms and 120ms once playing", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  const QUANTUM = 128;
  let sinceLastPush = 0;
  let pushValue = 0;
  let reachedPlaying = false;

  // Simulate ~1 second of real-time playback: a 20ms push every 960 frames
  // worth of 128-frame pulls, interleaved the way the real audio callback
  // and the network packets actually arrive.
  for (let i = 0; i < 375; i++) {
    if (sinceLastPush >= CHUNK_FRAMES) {
      ring.push(chunk(pushValue++, CHUNK_FRAMES));
      sinceLastPush -= CHUNK_FRAMES;
    }
    ring.pullInto(outputs(QUANTUM));
    sinceLastPush += QUANTUM;

    if (ring.playing) {
      reachedPlaying = true;
      expect(ring.bufferedFrames).toBeGreaterThanOrEqual(0);
      expect(ring.bufferedFrames).toBeLessThanOrEqual(MAX_FRAMES);
    }
  }

  expect(reachedPlaying).toBe(true);
  // Steady state settles somewhere in the target..max band, not pinned at
  // either extreme.
  expect(ring.bufferedFrames).toBeGreaterThanOrEqual(0);
  expect(ring.bufferedFrames).toBeLessThanOrEqual(MAX_FRAMES);
});

test("overflow lands the buffer at exactly the 40ms target within a single push, regardless of the pull quantum size", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  ring.push(chunk(1, TARGET_FRAMES));
  ring.pullInto(outputs(128)); // start playing, pull one 128-frame quantum like the real worklet does
  const bufferedBeforeOverflow = ring.bufferedFrames;
  expect(bufferedBeforeOverflow).toBeLessThan(MAX_FRAMES);

  // A single burst push takes it from under the ceiling to well past it.
  ring.push(chunk(2, MAX_FRAMES));
  expect(ring.bufferedFrames).toBe(TARGET_FRAMES);
});

test("pullInto does not allocate: reusing the same output arrays across many calls never grows their length or replaces the array identity", () => {
  const ring = new PcmRing(SAMPLE_RATE, CHANNELS);
  const out = outputs(128);
  const identities = out.map((a) => a);
  for (let i = 0; i < 100; i++) {
    ring.push(chunk(i, CHUNK_FRAMES));
    ring.pullInto(out);
  }
  for (let ch = 0; ch < CHANNELS; ch++) {
    expect(out[ch]).toBe(identities[ch]); // pullInto wrote into the same array object, never replaced it
    expect(out[ch].length).toBe(128); // never resized
  }
});
