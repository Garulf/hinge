export interface WritableLike {
  write(chunk: Uint8Array): boolean;
  once(event: "drain", listener: () => void): void;
  on(event: "error", listener: (e: Error) => void): void;
}

export interface QueuedWriter {
  write(chunk: Uint8Array): void;
  readonly failed: boolean;
  onError(cb: (e: Error) => void): void;
  /** Resolves once every chunk handed to write() so far has itself been handed to the stream's write(), or immediately once the stream has failed. */
  drain(): Promise<void>;
}

/**
 * Wraps a writable stream's write() so a chunk written while the stream is
 * applying backpressure (write() returned false) is queued instead of
 * dropped or written out of order, and flushed on "drain". A stream error
 * marks the writer failed: the queue is dropped and further writes are
 * ignored, so a caller does not keep buffering data that can never reach disk.
 */
export function createQueuedWriter(stream: WritableLike): QueuedWriter {
  let paused = false;
  let failed = false;
  const queue: Uint8Array[] = [];
  const errorCallbacks: Array<(e: Error) => void> = [];
  const drainWaiters: Array<() => void> = [];

  // A persistent listener, not once(): a stream can emit "error" more than
  // once (e.g. once during a write and again on end()), and missing a later
  // one would leave the writer thinking it is still healthy.
  stream.on("error", (e) => {
    if (failed) return;
    failed = true;
    queue.length = 0;
    for (const cb of errorCallbacks) cb(e);
    settleDrainWaiters();
  });

  function settleDrainWaiters(): void {
    if (paused && !failed) return;
    const waiters = drainWaiters.splice(0, drainWaiters.length);
    for (const resolve of waiters) resolve();
  }

  function onDrain(): void {
    paused = false;
    while (queue.length > 0 && !paused && !failed) {
      const chunk = queue.shift();
      if (chunk === undefined) break;
      if (!stream.write(chunk)) {
        paused = true;
        stream.once("drain", onDrain);
      }
    }
    settleDrainWaiters();
  }

  return {
    get failed() {
      return failed;
    },
    write(chunk) {
      if (failed) return;
      if (paused) {
        queue.push(chunk);
        return;
      }
      if (!stream.write(chunk)) {
        paused = true;
        stream.once("drain", onDrain);
      }
    },
    onError(cb) {
      errorCallbacks.push(cb);
    },
    drain(): Promise<void> {
      return new Promise((resolve) => {
        if (failed || (!paused && queue.length === 0)) {
          resolve();
          return;
        }
        drainWaiters.push(resolve);
      });
    },
  };
}
