import type { Adb } from "@yume-chan/adb";
import { ReadableStream } from "@yume-chan/stream-extra";
import { expect, test, vi } from "vitest";
import { PostureStream, startFoldMonitor, STATES_MARKER } from "../../src/main/fold-monitor";
import type { MediaSink } from "../../src/main/media-source";
import type { PostureReading } from "../../src/shared/posture";
import type { SessionStatus } from "../../src/shared/wire";

const PRINT_STATES = `Supported states: [
  DeviceState{identifier=0, name='CLOSED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=1, name='TENT', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=2, name='HALF_OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=3, name='OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
]`;

function readings(): { onReading: (r: PostureReading) => void; seen: PostureReading[] } {
  const seen: PostureReading[] = [];
  return { onReading: (r) => seen.push(r), seen };
}

test("PostureStream dedups identical consecutive readings", () => {
  const { onReading, seen } = readings();
  const stream = new PostureStream(onReading);
  stream.statesText(PRINT_STATES);
  stream.sample(["3", "mRotation=0"]);
  stream.sample(["3", "mRotation=0"]);
  expect(seen).toEqual([{ stateId: 3, posture: "open", rotation: 0 }]);
});

test("PostureStream emits again on a rotation-only change", () => {
  const { onReading, seen } = readings();
  const stream = new PostureStream(onReading);
  stream.statesText(PRINT_STATES);
  stream.sample(["3", "mRotation=0"]);
  stream.sample(["3", "mRotation=1"]);
  expect(seen).toEqual([
    { stateId: 3, posture: "open", rotation: 0 },
    { stateId: 3, posture: "open", rotation: 1 },
  ]);
});

test("a table from statesText and the same table from statesLine give identical readings", () => {
  const a = readings();
  const streamA = new PostureStream(a.onReading);
  streamA.statesText(PRINT_STATES);
  streamA.sample(["2", "mRotation=1"]);

  const b = readings();
  const streamB = new PostureStream(b.onReading);
  streamB.statesLine("@states 0=CLOSED,1=TENT,2=HALF_OPENED,3=OPENED");
  streamB.sample(["2", "mRotation=1"]);

  expect(a.seen).toEqual(b.seen);
});

test("tableLine() round-trips through statesLine", () => {
  const first = readings();
  const streamA = new PostureStream(first.onReading);
  streamA.statesText(PRINT_STATES);
  const line = streamA.tableLine();
  expect(line.startsWith(STATES_MARKER)).toBe(true);

  const second = readings();
  const streamB = new PostureStream(second.onReading);
  streamB.statesLine(line);
  streamB.sample(["1", "mRotation=2"]);
  streamA.sample(["1", "mRotation=2"]);

  expect(second.seen).toEqual(first.seen);
});

test("reset() forgets the last reading so the next sample() emits even if it repeats", () => {
  const { onReading, seen } = readings();
  const stream = new PostureStream(onReading);
  stream.statesText(PRINT_STATES);
  stream.sample(["0", "mRotation=0"]);
  stream.reset();
  stream.sample(["0", "mRotation=0"]);
  expect(seen).toEqual([
    { stateId: 0, posture: "closed", rotation: 0 },
    { stateId: 0, posture: "closed", rotation: 0 },
  ]);
});

function fakeSink(): { sink: MediaSink; postureLines: string[]; postures: PostureReading[]; statuses: SessionStatus[] } {
  const postureLines: string[] = [];
  const postures: PostureReading[] = [];
  const statuses: SessionStatus[] = [];
  const sink: MediaSink = {
    videoStart: () => {},
    videoPacket: () => {},
    videoEnd: () => {},
    status: (s) => statuses.push(s),
    postureLine: (l) => postureLines.push(l),
    posture: (r) => postures.push(r),
  };
  return { sink, postureLines, postures, statuses };
}

function fakeAdb(): Adb {
  return { marker: "adb" } as unknown as Adb;
}

function sampleBox(): { cb: ((lines: string[]) => void) | null; fire(lines: string[]): void } {
  return {
    cb: null,
    fire(lines) {
      this.cb?.(lines);
    },
  };
}

/** A SampleHandle whose `ended` never resolves on its own, for tests that don't care about the sampler dying. */
function neverEndingHandle(stop: () => Promise<void> = async () => {}): { stop: () => Promise<void>; ended: Promise<void> } {
  return { stop, ended: new Promise<void>(() => {}) };
}

test("startFoldMonitor reads the states table once, then starts the sampler and forwards readings and raw lines", async () => {
  const { sink, postureLines, postures } = fakeSink();
  const adb = fakeAdb();
  const box = sampleBox();
  const readStatesText = vi.fn(async () => PRINT_STATES);
  const startSample = vi.fn(async (_adb: unknown, onLines: (lines: string[]) => void) => {
    box.cb = onLines;
    return neverEndingHandle();
  });
  const stop = await startFoldMonitor(adb, sink, () => {}, { readStatesText, startSample });

  expect(readStatesText).toHaveBeenCalledTimes(1);
  expect(readStatesText).toHaveBeenCalledWith(adb);
  expect(startSample).toHaveBeenCalledTimes(1);
  expect(postureLines).toEqual([`${STATES_MARKER}0=CLOSED,1=TENT,2=HALF_OPENED,3=OPENED`]);

  box.fire(["3", "mRotation=1"]);
  expect(postureLines).toEqual([`${STATES_MARKER}0=CLOSED,1=TENT,2=HALF_OPENED,3=OPENED`, "3 | mRotation=1"]);
  expect(postures).toEqual([{ stateId: 3, posture: "open", rotation: 1 }]);

  await stop();
});

test("an empty/failed states table still lets rotation through", async () => {
  const { sink, postures } = fakeSink();
  const box = sampleBox();
  const readStatesText = vi.fn(async () => {
    throw new Error("adb shell failed");
  });
  const startSample = vi.fn(async (_adb: unknown, onLines: (lines: string[]) => void) => {
    box.cb = onLines;
    return neverEndingHandle();
  });
  const logs: string[] = [];

  const stop = await startFoldMonitor(fakeAdb(), sink, (l) => logs.push(l), { readStatesText, startSample });
  expect(logs.some((l) => l.includes("adb shell failed"))).toBe(true);

  box.fire(["3", "mRotation=2"]);
  expect(postures).toEqual([{ stateId: 3, posture: null, rotation: 2 }]);

  await stop();
});

test("the default print-states read is bounded by a 3s timeout and the sampler still starts", async () => {
  vi.useFakeTimers();
  try {
    const { sink } = fakeSink();
    const neverClosingStream = new ReadableStream<Uint8Array>({ start: () => {} });
    const adb = {
      subprocess: {
        shellProtocol: { spawn: async () => ({ stdout: neverClosingStream }) },
      },
    } as unknown as Adb;
    const logs: string[] = [];
    const startSample = vi.fn(async () => neverEndingHandle());

    const stopPromise = startFoldMonitor(adb, sink, (l) => logs.push(l), { startSample });
    await vi.advanceTimersByTimeAsync(3000);
    const stop = await stopPromise;

    expect(logs.some((l) => l.includes("print-states") && l.includes("3000ms"))).toBe(true);
    expect(startSample).toHaveBeenCalledTimes(1);
    await stop();
  } finally {
    vi.useRealTimers();
  }
});

test("a sampler that fails to start is restarted once after 2s, then gives up", async () => {
  vi.useFakeTimers();
  try {
    const { sink } = fakeSink();
    let attempts = 0;
    const startSample = vi.fn(async () => {
      attempts++;
      throw new Error(`spawn failed ${attempts}`);
    });
    const logs: string[] = [];

    const stopPromise = startFoldMonitor(fakeAdb(), sink, (l) => logs.push(l), {
      readStatesText: async () => "",
      startSample,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toBe(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toBe(2);

    const stop = await stopPromise;
    expect(logs.filter((l) => l.includes("spawn failed")).length).toBe(2);
    await stop();
  } finally {
    vi.useRealTimers();
  }
});

test("a sampler that exits unexpectedly mid-session is restarted once after 2s, then a second exit gives up", async () => {
  vi.useFakeTimers();
  try {
    const { sink } = fakeSink();
    let starts = 0;
    const endedResolvers: Array<() => void> = [];
    const startSample = vi.fn(async () => {
      starts++;
      const ended = new Promise<void>((resolve) => {
        endedResolvers.push(resolve);
      });
      return { stop: async () => {}, ended };
    });
    const logs: string[] = [];

    const stop = await startFoldMonitor(fakeAdb(), sink, (l) => logs.push(l), {
      readStatesText: async () => "",
      startSample,
    });
    expect(starts).toBe(1);

    // The shell exits on its own (crash, adb disconnect, ...): restarted once, after the same 2s delay.
    endedResolvers[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.some((l) => l.includes("exited unexpectedly"))).toBe(true);
    expect(starts).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(starts).toBe(2);

    // A second death gives up: no further restart.
    endedResolvers[1]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts).toBe(2);
    expect(logs.filter((l) => l.includes("exited unexpectedly")).length).toBe(2);

    await stop();
  } finally {
    vi.useRealTimers();
  }
});

test("stop() honours a sampler death that races the stop: no restart once stopped", async () => {
  const { sink } = fakeSink();
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const logs: string[] = [];
  const startSample = async () => ({ stop: async () => {}, ended });

  const stop = await startFoldMonitor(fakeAdb(), sink, (l) => logs.push(l), { readStatesText: async () => "", startSample });
  await stop();
  resolveEnded();
  await new Promise((r) => setImmediate(r));

  expect(logs.some((l) => l.includes("exited unexpectedly"))).toBe(false);
});

test("stop() stops the sampler", async () => {
  const { sink } = fakeSink();
  let stopped = false;
  const startSample = async () => neverEndingHandle(async () => {
    stopped = true;
  });
  const stop = await startFoldMonitor(fakeAdb(), sink, () => {}, { readStatesText: async () => "", startSample });
  await stop();
  expect(stopped).toBe(true);
});
