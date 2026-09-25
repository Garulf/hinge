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

function oneShotClient(reader: () => ReadableStream<{ type: "data"; data: Uint8Array }>) {
  return {
    videoStream: Promise.resolve({
      metadata: { codec: 1, deviceName: "Pixel" },
      width: 100,
      height: 200,
      stream: reader(),
    }),
    output: new ReadableStream<string>({ start: (c) => c.close() }),
    controller: {},
    close: async () => {},
  };
}

function baseOpts(deps: Partial<ScrcpyServerDeps>, extra?: Partial<{ firstPacketTimeoutMs: number; log: (l: string) => void }>) {
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
