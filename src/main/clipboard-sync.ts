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
  /** A fresh sequence number for a setClipboard control message (the content parameter is accepted for call-site compatibility but not otherwise used: see the echo check in start()). */
  beginPush(content: string): bigint;
}

export function createClipboardSync(opts: {
  stream: ClipboardStreamLike | undefined;
  host: ClipboardHost;
  log?: (line: string) => void;
}): ClipboardSync {
  let sequence = 0n;
  let stopped = false;
  let reader: ReturnType<ClipboardStreamLike["getReader"]> | null = null;

  return {
    beginPush() {
      sequence += 1n;
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

          // scrcpy's own approach: skip the write whenever the incoming
          // value already matches what's on the PC clipboard right now.
          // This catches our own echo (we just set the device clipboard to
          // this value, so it's already here) without remembering
          // anything about past pushes, so it can never grow unbounded or
          // swallow a genuine later copy of the same text.
          let current: string;
          try {
            current = await opts.host.readText();
          } catch (e) {
            opts.log?.(`clipboard read failed: ${String(e)}`);
            current = "";
          }
          if (value === current) continue;

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
