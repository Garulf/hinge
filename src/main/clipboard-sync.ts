/** Matches Electron's own (fully async, since Electron 44) clipboard module shape. */
export interface ClipboardHost {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

/**
 * Structurally minimal so both the DOM ReadableStream and Tango's own
 * (`@yume-chan/stream-extra`) ReadableStream satisfy it: only getReader()
 * is used, and requiring the full ReadableStream shape (pipeThrough etc.,
 * which differ subtly between the two) would reject one or the other.
 */
export interface ClipboardStreamLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: string }>;
    cancel(reason?: unknown): Promise<void>;
  };
}

export interface ClipboardSync {
  /** Drains the device clipboard stream until it ends or stop() is called; resolves when draining stops. Safe to call once. */
  start(): Promise<void>;
  stop(): void;
  /**
   * Registers content about to be pushed to the device (setClipboard) and
   * returns the sequence number to send with it. The next device-clipboard
   * value that matches it is treated as the resulting echo and is not
   * written back to the PC clipboard, which would otherwise loop.
   */
  beginPush(content: string): bigint;
}

export function createClipboardSync(opts: {
  stream: ClipboardStreamLike | undefined;
  host: ClipboardHost;
  log?: (line: string) => void;
}): ClipboardSync {
  let sequence = 0n;
  // Counts, not a single value: two pushes in flight before either echo
  // arrives must each be caught, not just the most recent one.
  const pending = new Map<string, number>();
  let stopped = false;
  let reader: ReturnType<ClipboardStreamLike["getReader"]> | null = null;

  return {
    beginPush(content) {
      sequence += 1n;
      pending.set(content, (pending.get(content) ?? 0) + 1);
      return sequence;
    },

    async start() {
      const stream = opts.stream;
      if (!stream) return;
      reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done || value === undefined) return;
          const count = pending.get(value);
          if (count) {
            if (count === 1) pending.delete(value);
            else pending.set(value, count - 1);
            continue;
          }
          try {
            await opts.host.writeText(value);
          } catch (e) {
            opts.log?.(`clipboard write failed: ${String(e)}`);
          }
        }
      } catch (e) {
        if (!stopped) opts.log?.(`clipboard stream error: ${String(e)}`);
      }
    },

    stop() {
      stopped = true;
      void reader?.cancel().catch(() => {});
    },
  };
}
