import { expect, test } from "vitest";
import { createQueuedWriter, type WritableLike } from "../../src/main/queued-writer";

function fakeStream(returnsFalseFor: number[] = []): WritableLike & { writes: Uint8Array[]; drain: () => void; error: (e: Error) => void } {
  const writes: Uint8Array[] = [];
  let drainListener: (() => void) | null = null;
  let errorListener: ((e: Error) => void) | null = null;
  return {
    writes,
    write(chunk) {
      writes.push(chunk);
      return !returnsFalseFor.includes(writes.length - 1);
    },
    once(event, listener) {
      if (event === "drain") drainListener = listener as () => void;
      if (event === "error") errorListener = listener as (e: Error) => void;
    },
    drain() {
      const listener = drainListener;
      drainListener = null;
      listener?.();
    },
    error(e) {
      errorListener?.(e);
    },
  };
}

test("writes straight through while the stream accepts data", () => {
  const stream = fakeStream();
  const writer = createQueuedWriter(stream);
  writer.write(new Uint8Array([1]));
  writer.write(new Uint8Array([2]));
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
});

test("queues chunks written while the stream applies backpressure, then flushes them in order on drain", () => {
  const stream = fakeStream([0]);
  const writer = createQueuedWriter(stream);
  writer.write(new Uint8Array([1]));
  writer.write(new Uint8Array([2]));
  writer.write(new Uint8Array([3]));
  expect(stream.writes).toEqual([new Uint8Array([1])]);

  stream.drain();
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
});

test("re-pauses if the queued flush itself hits backpressure again", () => {
  const stream = fakeStream([0, 1]);
  const writer = createQueuedWriter(stream);
  writer.write(new Uint8Array([1]));
  writer.write(new Uint8Array([2]));
  writer.write(new Uint8Array([3]));
  expect(stream.writes).toEqual([new Uint8Array([1])]);

  stream.drain();
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2])]);

  stream.drain();
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
});

test("drain() resolves once queued chunks are all handed to write()", async () => {
  const stream = fakeStream([0]);
  const writer = createQueuedWriter(stream);
  writer.write(new Uint8Array([1]));
  writer.write(new Uint8Array([2]));

  let resolved = false;
  const p = writer.drain().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);

  stream.drain();
  await p;
  expect(resolved).toBe(true);
});

test("drain() resolves immediately when there is nothing queued", async () => {
  const stream = fakeStream();
  const writer = createQueuedWriter(stream);
  writer.write(new Uint8Array([1]));
  let resolved = false;
  void writer.drain().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(true);
});

test("a stream error marks the writer failed, drops the queue and stops accepting further writes", () => {
  const stream = fakeStream([0]);
  const writer = createQueuedWriter(stream);
  writer.write(new Uint8Array([1]));
  writer.write(new Uint8Array([2]));
  expect(writer.failed).toBe(false);

  const seen: Error[] = [];
  writer.onError((e) => seen.push(e));
  const err = new Error("disk full");
  stream.error(err);

  expect(writer.failed).toBe(true);
  expect(seen).toEqual([err]);

  writer.write(new Uint8Array([3]));
  stream.drain();
  expect(stream.writes).toEqual([new Uint8Array([1])]);
});

test("drain() resolves immediately after a failure instead of waiting for a drain that will never come", async () => {
  const stream = fakeStream([0]);
  const writer = createQueuedWriter(stream);
  writer.write(new Uint8Array([1]));
  writer.write(new Uint8Array([2]));
  stream.error(new Error("boom"));

  let resolved = false;
  void writer.drain().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(true);
});
