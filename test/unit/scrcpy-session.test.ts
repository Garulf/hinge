import { expect, test } from "vitest";
import { ScrcpySession, type ScrcpyServerDeps } from "../../src/main/scrcpy-session";
import type { MediaSink } from "../../src/main/media-source";
import { DEFAULT_STREAM_SETTINGS } from "../../src/main/scrcpy-init";
import type { SessionStatus } from "../../src/shared/wire";

function fakeSink(): { sink: MediaSink; statuses: SessionStatus[]; packets: unknown[]; endCalls: () => number } {
  const statuses: SessionStatus[] = [];
  const packets: unknown[] = [];
  let ended = 0;
  const sink: MediaSink = {
    videoStart: () => {},
    videoPacket: (p) => packets.push(p),
    videoEnd: () => {
      ended++;
    },
    status: (s) => statuses.push(s),
  };
  return { sink, statuses, packets, endCalls: () => ended };
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
  opts?: { controller?: unknown; clipboard?: ReadableStream<string> },
) {
  return {
    videoStream: Promise.resolve({
      metadata: { codec: 1, deviceName: "Pixel" },
      width: 100,
      height: 200,
      stream: reader(),
    }),
    output: new ReadableStream<string>({ start: (c) => c.close() }),
    controller: opts?.controller ?? {},
    clipboard: opts?.clipboard,
    close: async () => {},
  };
}

function baseOpts(
  deps: Partial<ScrcpyServerDeps>,
  extra?: Partial<{ firstPacketTimeoutMs: number; log: (l: string) => void; clipboardHost: { readText: () => Promise<string>; writeText: (t: string) => Promise<void> } }>,
) {
  return {
    adb: {} as never,
    serial: "S1",
    model: "Pixel",
    serverPath: "/vendor/scrcpy-server-v4.1",
    settings: DEFAULT_STREAM_SETTINGS,
    deps,
    ...extra,
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

  expect(statuses).toContainEqual({ state: "streaming", serial: "S1", model: "Pixel" });
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
