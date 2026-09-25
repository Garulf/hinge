export interface WritableLike {
  write(chunk: Uint8Array): boolean;
  once(event: "drain", listener: () => void): void;
}

/**
 * Wraps a writable stream's write() so a chunk written while the stream is
 * applying backpressure (write() returned false) is queued instead of
 * dropped or written out of order, and flushed on "drain".
 */
export function createQueuedWriter(stream: WritableLike): (chunk: Uint8Array) => void {
  let paused = false;
  const queue: Uint8Array[] = [];

  function onDrain(): void {
    paused = false;
    while (queue.length > 0 && !paused) {
      const chunk = queue.shift();
      if (chunk === undefined) break;
      if (!stream.write(chunk)) {
        paused = true;
        stream.once("drain", onDrain);
      }
    }
  }

  return (chunk: Uint8Array) => {
    if (paused) {
      queue.push(chunk);
      return;
    }
    if (!stream.write(chunk)) {
      paused = true;
      stream.once("drain", onDrain);
    }
  };
}
