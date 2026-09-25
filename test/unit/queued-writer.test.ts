import { expect, test } from "vitest";
import { createQueuedWriter, type WritableLike } from "../../src/main/queued-writer";

function fakeStream(returnsFalseFor: number[] = []): WritableLike & { writes: Uint8Array[]; drain: () => void } {
  const writes: Uint8Array[] = [];
  let drainListener: (() => void) | null = null;
  return {
    writes,
    write(chunk) {
      writes.push(chunk);
      return !returnsFalseFor.includes(writes.length - 1);
    },
    once(event, listener) {
      if (event === "drain") drainListener = listener;
    },
    drain() {
      const listener = drainListener;
      drainListener = null;
      listener?.();
    },
  };
}

test("writes straight through while the stream accepts data", () => {
  const stream = fakeStream();
  const write = createQueuedWriter(stream);
  write(new Uint8Array([1]));
  write(new Uint8Array([2]));
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
});

test("queues chunks written while the stream applies backpressure, then flushes them in order on drain", () => {
  const stream = fakeStream([0]);
  const write = createQueuedWriter(stream);
  write(new Uint8Array([1]));
  write(new Uint8Array([2]));
  write(new Uint8Array([3]));
  expect(stream.writes).toEqual([new Uint8Array([1])]);

  stream.drain();
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
});

test("re-pauses if the queued flush itself hits backpressure again", () => {
  const stream = fakeStream([0, 1]);
  const write = createQueuedWriter(stream);
  write(new Uint8Array([1]));
  write(new Uint8Array([2]));
  write(new Uint8Array([3]));
  expect(stream.writes).toEqual([new Uint8Array([1])]);

  stream.drain();
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2])]);

  stream.drain();
  expect(stream.writes).toEqual([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
});
