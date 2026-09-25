import { expect, test } from "vitest";
import { ScrcpySession, type ScrcpyServerDeps } from "../../src/main/scrcpy-session";
import type { MediaSink } from "../../src/main/media-source";
import { DEFAULT_STREAM_SETTINGS } from "../../src/main/scrcpy-init";
import type { TransferDeps } from "../../src/main/transfers";
import type { SessionStatus, TransferProgress } from "../../src/shared/wire";

function fakeSink(): {
  sink: MediaSink;
  statuses: SessionStatus[];
  packets: unknown[];
  endCalls: () => number;
  audioStarts: unknown[];
  audioPackets: unknown[];
  audioEnds: (string | undefined)[];
  transfers: TransferProgress[];
} {
  const statuses: SessionStatus[] = [];
  const packets: unknown[] = [];
  const audioStarts: unknown[] = [];
  const audioPackets: unknown[] = [];
  const audioEnds: (string | undefined)[] = [];
  const transfers: TransferProgress[] = [];
  let ended = 0;
  const sink: MediaSink = {
    videoStart: () => {},
    videoPacket: (p) => packets.push(p),
    videoEnd: () => {
      ended++;
    },
    status: (s) => statuses.push(s),
    audioStart: (info) => audioStarts.push(info),
    audioPacket: (p) => audioPackets.push(p),
    audioEnd: (reason) => audioEnds.push(reason),
    transferProgress: (p) => transfers.push(p),
  };
  return { sink, statuses, packets, endCalls: () => ended, audioStarts, audioPackets, audioEnds, transfers };
}

function neverEndingStream(): ReadableStream<{ type: "data"; data: Uint8Array }> {
  return new ReadableStream({
    start: () => {
      // never enqueues, never closes: simulates a server that hangs before the first frame
    },
  });
}

function oneShotClient(
  reader: () => ReadableStream<{ type: "data"; data: Uint8Array }>,
  opts?: { controller?: unknown; clipboard?: ReadableStream<string>; audioStream?: unknown },
) {
  return {
    videoStream: Promise.resolve({
      metadata: { codec: 1, deviceName: "Pixel" },
      width: 100,
      height: 200,
      stream: reader(),
    }),
    audioStream: opts?.audioStream ?? Promise.resolve({ type: "disabled" }),
    output: new ReadableStream<string>({ start: (c) => c.close() }),
    controller: opts?.controller ?? {},
    clipboard: opts?.clipboard,
    close: async () => {},
  };
}

function baseOpts(
  deps: Partial<ScrcpyServerDeps>,
  extra?: Partial<{
    firstPacketTimeoutMs: number;
    log: (l: string) => void;
    clipboardHost: { readText: () => Promise<string>; writeText: (t: string) => Promise<void> };
    transferDeps: Partial<TransferDeps>;
    settingsOverride: Partial<typeof DEFAULT_STREAM_SETTINGS>;
  }>,
) {
  const { settingsOverride, ...rest } = extra ?? {};
  return {
    adb: {} as never,
    serial: "S1",
    model: "Pixel",
    serverPath: "/vendor/scrcpy-server-v4.1",
    settings: { ...DEFAULT_STREAM_SETTINGS, ...settingsOverride },
    deps,
    ...rest,
  };
}

test("pushes the server jar fresh on every attempt, not just the first", async () => {
  let pushCount = 0;
  let startCount = 0;
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {
      pushCount++;
    },
    startClient: async () => {
      startCount++;
      throw new Error(`attempt ${startCount} boom`);
    },
  };
  const session = new ScrcpySession(baseOpts(deps));
  const { sink, statuses } = fakeSink();
  await session.start(sink);

  expect(pushCount).toBe(3);
  expect(startCount).toBe(3);
  expect(statuses.at(-1)?.state).toBe("error");
});

test("a server that never emits a first packet fails that attempt on a timeout instead of hanging forever", async () => {
  let startCount = 0;
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => {
      startCount++;
      return oneShotClient(neverEndingStream) as never;
    },
  };
  const session = new ScrcpySession(baseOpts(deps, { firstPacketTimeoutMs: 5 }));
  const { sink, statuses } = fakeSink();
  await session.start(sink);

  expect(startCount).toBe(3);
  const last = statuses.at(-1);
  expect(last?.state).toBe("error");
  expect(last?.state === "error" && last.message).toMatch(/no video packet within/);
});

test("a startClient() that hangs forever fails that attempt on the same timeout as the first packet, instead of hanging", async () => {
  let startCount = 0;
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => {
      startCount++;
      return new Promise(() => {}) as never; // never resolves
    },
  };
  const session = new ScrcpySession(baseOpts(deps, { firstPacketTimeoutMs: 5 }));
  const { sink, statuses } = fakeSink();
  await session.start(sink);

  expect(startCount).toBe(3);
  const last = statuses.at(-1);
  expect(last?.state).toBe("error");
  expect(last?.state === "error" && last.message).toMatch(/scrcpy server did not start within \d+ms/);
});

test("a startClient() that resolves after its own timeout has already moved the attempt on is closed instead of leaked", async () => {
  const resolvers: Array<(c: { close: () => Promise<void> }) => void> = [];
  const closeCalls: number[] = [];
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () =>
      new Promise((resolve) => {
        resolvers.push((c) => resolve(c as never));
      }) as never,
  };
  const session = new ScrcpySession(baseOpts(deps, { firstPacketTimeoutMs: 5 }));
  const { sink } = fakeSink();
  await session.start(sink);

  expect(resolvers).toHaveLength(3);

  // The first attempt's startClient() resolves well after its own 5ms
  // timeout already rejected that attempt and moved on to the next one.
  resolvers[0]({
    close: async () => {
      closeCalls.push(0);
    },
  });
  await new Promise((r) => setImmediate(r));

  expect(closeCalls).toEqual([0]);
});

test("a videoStream that hangs forever fails that attempt on the same timeout as the first packet, instead of hanging", async () => {
  let startCount = 0;
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => {
      startCount++;
      return {
        videoStream: new Promise(() => {}), // never resolves
        output: new ReadableStream<string>({ start: (c) => c.close() }),
        controller: {},
        close: async () => {},
      } as never;
    },
  };
  const session = new ScrcpySession(baseOpts(deps, { firstPacketTimeoutMs: 5 }));
  const { sink, statuses } = fakeSink();
  await session.start(sink);

  expect(startCount).toBe(3);
  const last = statuses.at(-1);
  expect(last?.state).toBe("error");
  expect(last?.state === "error" && last.message).toMatch(/no video stream within/);
});

test("a session that streams successfully posts one streaming status and the first packet", async () => {
  let controller!: ReadableStreamDefaultController<{ type: "data"; data: Uint8Array }>;
  const stream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => {
      controller = c;
      c.enqueue({ type: "data", data: new Uint8Array([7]) });
    },
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(() => stream) as never,
  };
  const session = new ScrcpySession(baseOpts(deps));
  const { sink, statuses, packets } = fakeSink();
  await session.start(sink);

  expect(statuses).toContainEqual({ state: "streaming", serial: "S1", model: "Pixel", deviceId: "S1" });
  expect(packets).toHaveLength(1);
  await session.stop();
  controller.close();
});

test("stop() guards the pump: no packet or end event is posted for reads that settle after stop", async () => {
  let controller!: ReadableStreamDefaultController<{ type: "data"; data: Uint8Array }>;
  const stream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => {
      controller = c;
      c.enqueue({ type: "data", data: new Uint8Array([1]) });
    },
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(() => stream) as never,
  };
  const session = new ScrcpySession(baseOpts(deps));
  const sink2 = fakeSink();
  await session.start(sink2.sink);
  expect(sink2.packets).toHaveLength(1);

  await session.stop();
  // A packet that was already in flight when stop() was called must not be
  // delivered, and videoEnd() must not fire once the session is stopped.
  controller.enqueue({ type: "data", data: new Uint8Array([2]) });
  controller.close();
  await new Promise((r) => setImmediate(r));

  expect(sink2.packets).toHaveLength(1);
  expect(sink2.endCalls()).toBe(0);
});

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test("a successful session drains client.clipboard and writes device clipboard changes to the PC clipboard", async () => {
  let clipboardController!: ReadableStreamDefaultController<string>;
  const clipboard = new ReadableStream<string>({ start: (c) => { clipboardController = c; } });
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(() => videoStream, { clipboard }) as never,
  };
  const written: string[] = [];
  const session = new ScrcpySession(
    baseOpts(deps, { clipboardHost: { readText: async () => "", writeText: async (t) => { written.push(t); } } }),
  );
  const { sink } = fakeSink();
  await session.start(sink);

  clipboardController.enqueue("copied on the phone");
  await flush();

  expect(written).toEqual(["copied on the phone"]);
  await session.stop();
});

test("control(clipboard-paste) reads the PC clipboard and sets the device clipboard with a fresh sequence, then that echo is not looped back to the PC clipboard", async () => {
  let clipboardController!: ReadableStreamDefaultController<string>;
  const clipboard = new ReadableStream<string>({ start: (c) => { clipboardController = c; } });
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const setClipboardCalls: unknown[] = [];
  const controller = {
    setClipboard: async (m: unknown) => {
      setClipboardCalls.push(m);
    },
  };
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(() => videoStream, { clipboard, controller }) as never,
  };
  const written: string[] = [];
  const session = new ScrcpySession(
    baseOpts(deps, { clipboardHost: { readText: async () => "from the pc", writeText: async (t) => { written.push(t); } } }),
  );
  const { sink } = fakeSink();
  await session.start(sink);

  session.control({ type: "clipboard-paste", asText: false });
  await flush();

  expect(setClipboardCalls).toEqual([{ content: "from the pc", sequence: 1n, paste: true }]);

  // the device applying that set is reported back over client.clipboard as
  // a "change" to the identical content; it must not bounce to the PC.
  clipboardController.enqueue("from the pc");
  await flush();
  expect(written).toEqual([]);

  await session.stop();
});

test("a successful audio stream posts audio-start with the Opus codec id and forwards packets, then audio-end when the stream closes", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  let audioController!: ReadableStreamDefaultController<{ type: "data"; data: Uint8Array }>;
  const audioStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({ start: (c) => { audioController = c; } });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () =>
      oneShotClient(() => videoStream, {
        audioStream: Promise.resolve({ type: "success", codec: { webCodecId: "opus" }, stream: audioStream }),
      }) as never,
  };
  const session = new ScrcpySession(baseOpts(deps));
  const { sink, audioStarts, audioPackets, audioEnds } = fakeSink();
  await session.start(sink);
  await flush();

  expect(audioStarts).toEqual([{ codec: "opus", sampleRate: 48000, channels: 2 }]);

  audioController.enqueue({ type: "data", data: new Uint8Array([9]) });
  audioController.close();
  await flush();

  expect(audioPackets).toEqual([{ type: "data", pts: null, data: new Uint8Array([9]) }]);
  expect(audioEnds).toEqual([undefined]);

  await session.stop();
});

test("audio turned off in settings posts audio-end('disabled'), not 'unsupported', and never touches client.audioStream", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => ({
      ...oneShotClient(() => videoStream),
      get audioStream(): never {
        throw new Error("must not be touched when audio is off in settings");
      },
    }) as never,
  };
  const session = new ScrcpySession(baseOpts(deps, { settingsOverride: { audio: false } }));
  const { sink, audioStarts, audioEnds } = fakeSink();
  await session.start(sink);
  await flush();

  expect(audioStarts).toEqual([]);
  expect(audioEnds).toEqual(["disabled"]);

  await session.stop();
});

test("disabled or errored audio metadata posts one audio-end('unsupported') and never audio-start", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () =>
      oneShotClient(() => videoStream, { audioStream: Promise.resolve({ type: "errored" }) }) as never,
  };
  const session = new ScrcpySession(baseOpts(deps));
  const { sink, audioStarts, audioEnds } = fakeSink();
  await session.start(sink);
  await flush();

  expect(audioStarts).toEqual([]);
  expect(audioEnds).toEqual(["unsupported"]);

  await session.stop();
});

test("an audio stream that errors mid-stream posts audio-end('unsupported') instead of hanging or crashing", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const audioStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.error(new Error("audio socket closed")),
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () =>
      oneShotClient(() => videoStream, {
        audioStream: Promise.resolve({ type: "success", codec: { webCodecId: "opus" }, stream: audioStream }),
      }) as never,
  };
  const logs: string[] = [];
  const session = new ScrcpySession(baseOpts(deps, { log: (l) => logs.push(l) }));
  const { sink, audioEnds } = fakeSink();
  await session.start(sink);
  await flush();

  expect(audioEnds).toEqual(["unsupported"]);
  expect(logs.some((l) => l.includes("audio socket closed"))).toBe(true);

  await session.stop();
});

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("transfer() enqueues onto the session's transfer queue and progress reaches the sink as transfer-progress", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(() => videoStream) as never,
  };
  const pushes: string[] = [];
  const transferDeps: Partial<TransferDeps> = {
    openFile: async () => ({ size: 5, stream: textStream("hello") }),
    pushFile: async (path, stream) => {
      pushes.push(path);
      const reader = stream.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    },
    scanFile: async () => {},
  };
  const session = new ScrcpySession(baseOpts(deps, { transferDeps }));
  const { sink, transfers } = fakeSink();
  await session.start(sink);

  session.transfer(["/tmp/notes.txt"]);
  await flush();
  await flush();

  expect(pushes).toEqual(["/sdcard/Download/notes.txt"]);
  expect(transfers.map((p) => p.state)).toEqual(["queued", "running", "running", "done"]);
});

test("stop() cancels an in-flight transfer instead of letting it finish and be announced done, exactly as a device switch requires", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(() => videoStream) as never,
  };
  let releasePush!: () => void;
  const pushGate = new Promise<void>((resolve) => {
    releasePush = resolve;
  });
  const transferDeps: Partial<TransferDeps> = {
    openFile: async () => ({ size: 5, stream: textStream("hello") }),
    pushFile: async (_path, stream) => {
      const reader = stream.getReader();
      await reader.read(); // consumes the one chunk, firing the second "running" progress event
      await pushGate;
      throw new Error("push aborted");
    },
    scanFile: async () => {},
  };
  const session = new ScrcpySession(baseOpts(deps, { transferDeps }));
  const { sink, transfers } = fakeSink();
  await session.start(sink);

  session.transfer(["/tmp/big.bin"]);
  await flush();
  expect(transfers.map((p) => p.state)).toEqual(["queued", "running", "running"]);

  await session.stop();
  releasePush();
  await flush();

  expect(transfers.map((p) => p.state)).toEqual(["queued", "running", "running", "cancelled"]);
  expect(transfers.some((p) => p.state === "done")).toBe(false);
});

test("with no audioStart consumer on the sink, the audio stream is still opened and cancelled rather than left unread", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  let cancelled = false;
  const audioStream = {
    getReader: () => {
      throw new Error("must not be read when there is no consumer");
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () =>
      oneShotClient(() => videoStream, {
        audioStream: Promise.resolve({ type: "success", codec: { webCodecId: "opus" }, stream: audioStream }),
      }) as never,
  };
  const session = new ScrcpySession(baseOpts(deps));
  // A sink with no audioStart at all, unlike fakeSink(): exactly the shape
  // a minimal consumer (or a stale tee) might have.
  const sink: MediaSink = { videoStart: () => {}, videoPacket: () => {}, videoEnd: () => {}, status: () => {} };
  await session.start(sink);
  await flush();

  expect(cancelled).toBe(true);

  await session.stop();
});

test("a name with spaces and non-ASCII characters reaches the real adb.sync.write bridge unchanged, not just the abstracted TransferDeps", async () => {
  const videoStream = new ReadableStream<{ type: "data"; data: Uint8Array }>({
    start: (c) => c.enqueue({ type: "data", data: new Uint8Array([1]) }),
  });
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(() => videoStream) as never,
  };
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const fakeAdb = {
    subprocess: { shellProtocol: undefined },
    sync: {
      write: async ({ path, readable }: { path: string; readable: ReadableStream<Uint8Array> }) => {
        const reader = readable.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
        writes.push({ path, bytes });
      },
    },
  };
  const name = "my résumé (final) 简历.pdf";
  const content = new TextEncoder().encode("pdf-bytes");
  const session = new ScrcpySession({
    adb: fakeAdb as never,
    serial: "S1",
    model: "Pixel",
    serverPath: "/vendor/scrcpy-server-v4.1",
    settings: DEFAULT_STREAM_SETTINGS,
    deps,
    transferDeps: {
      openFile: async () => ({ size: content.byteLength, stream: new ReadableStream({ start: (c) => { c.enqueue(content); c.close(); } }) }),
      scanFile: async () => {},
    },
  });
  const { sink } = fakeSink();
  await session.start(sink);

  session.transfer([`/home/user/${name}`]);
  await flush();
  await flush();

  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe(`/sdcard/Download/${name}`);
  expect(new TextDecoder().decode(writes[0].bytes)).toBe("pdf-bytes");

  await session.stop();
});
