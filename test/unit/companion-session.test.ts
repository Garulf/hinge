import { expect, test } from "vitest";
import { CompanionSession, type AudioSink } from "../../src/main/companion-session";
import { DEFAULT_STREAM_SETTINGS, type StreamSettings } from "../../src/main/scrcpy-init";
import type { ScrcpyServerDeps } from "../../src/main/scrcpy-session";
import type { ClipboardHost } from "../../src/main/clipboard-sync";

type AudioChunk = { type: "data"; data: Uint8Array };

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function fakeAudioSink(): { sink: AudioSink; starts: unknown[]; packets: unknown[]; ends: (string | undefined)[] } {
  const starts: unknown[] = [];
  const packets: unknown[] = [];
  const ends: (string | undefined)[] = [];
  return {
    sink: {
      audioStart: (info) => starts.push(info),
      audioPacket: (p) => packets.push(p),
      audioEnd: (reason) => ends.push(reason),
    },
    starts,
    packets,
    ends,
  };
}

function fakeServer(opts?: { audioStream?: unknown; clipboard?: ReadableStream<string> }) {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  let closes = 0;
  const startedWith: string[][] = [];
  const client = {
    audioStream: opts?.audioStream ?? Promise.resolve({ type: "disabled" }),
    output: new ReadableStream<string>({ start: (c) => c.close() }),
    controller: {},
    clipboard: opts?.clipboard,
    exited,
    close: async () => {
      closes++;
    },
  };
  const deps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async (_adb, options) => {
      startedWith.push(options.serialize());
      return client as never;
    },
  };
  return { deps, exit, closes: () => closes, startedWith };
}

function companion(deps: Partial<ScrcpyServerDeps>, extra?: { settings?: Partial<StreamSettings>; clipboardHost?: ClipboardHost }) {
  return new CompanionSession({
    adb: {} as never,
    serverPath: "/vendor/scrcpy-server-v4.1",
    settings: { ...DEFAULT_STREAM_SETTINGS, ...extra?.settings },
    clipboardHost: extra?.clipboardHost,
    deps,
  });
}

test("starts a scrcpy server with no video", async () => {
  const server = fakeServer();
  const session = companion(server.deps);
  await session.start(fakeAudioSink().sink);

  expect(server.startedWith).toHaveLength(1);
  expect(server.startedWith[0]).toContain("video=false");
  await session.stop();
});

test("forwards audio once the stream metadata arrives", async () => {
  let audio!: ReadableStreamDefaultController<AudioChunk>;
  const stream = new ReadableStream<AudioChunk>({ start: (c) => { audio = c; } });
  const server = fakeServer({ audioStream: Promise.resolve({ type: "success", codec: { webCodecId: "opus" }, stream }) });
  const session = companion(server.deps);
  const { sink, starts, packets } = fakeAudioSink();
  await session.start(sink);
  await flush();

  expect(starts).toEqual([{ codec: "opus", sampleRate: 48000, channels: 2 }]);
  audio.enqueue({ type: "data", data: new Uint8Array([9]) });
  await flush();
  expect(packets).toEqual([{ type: "data", pts: null, data: new Uint8Array([9]) }]);
  await session.stop();
});

test("audio turned off in settings ends audio as disabled", async () => {
  const server = fakeServer();
  const session = companion(server.deps, { settings: { audio: false } });
  const { sink, starts, ends } = fakeAudioSink();
  await session.start(sink);
  await flush();

  expect(starts).toEqual([]);
  expect(ends).toEqual(["disabled"]);
  await session.stop();
});

test("pushes get increasing sequences and the device's echo of a push is not written back to the PC", async () => {
  let device!: ReadableStreamDefaultController<string>;
  const clipboard = new ReadableStream<string>({ start: (c) => { device = c; } });
  const server = fakeServer({ clipboard });
  const written: string[] = [];
  let pcClipboard = "x";
  const session = companion(server.deps, {
    clipboardHost: {
      readText: async () => pcClipboard,
      writeText: async (t) => {
        written.push(t);
        pcClipboard = t;
      },
    },
  });
  await session.start(fakeAudioSink().sink);

  const first = session.beginPush("x");
  const second = session.beginPush("x");
  expect(second).toBeGreaterThan(first);

  device.enqueue("x");
  await flush();
  expect(written).toEqual([]);

  device.enqueue("copied on the phone");
  await flush();
  expect(written).toEqual(["copied on the phone"]);
  await session.stop();
});

test("stop() closes the client and ended stays pending", async () => {
  const server = fakeServer();
  const session = companion(server.deps);
  await session.start(fakeAudioSink().sink);
  let ended = false;
  void session.ended.then(() => {
    ended = true;
  });

  await session.stop();
  server.exit();
  await flush();

  expect(server.closes()).toBe(1);
  expect(ended).toBe(false);
});

test("ended resolves when the server exits on its own", async () => {
  const server = fakeServer();
  const session = companion(server.deps);
  await session.start(fakeAudioSink().sink);
  let ended = false;
  void session.ended.then(() => {
    ended = true;
  });
  await flush();
  expect(ended).toBe(false);

  server.exit();
  await flush();
  expect(ended).toBe(true);
});

test("a server that fails to start ends the session instead of retrying", async () => {
  let starts = 0;
  const logs: string[] = [];
  const session = new CompanionSession({
    adb: {} as never,
    serverPath: "/vendor/scrcpy-server-v4.1",
    settings: DEFAULT_STREAM_SETTINGS,
    log: (l) => logs.push(l),
    deps: {
      readServerJar: async () => new Uint8Array([1]),
      pushServer: async () => {},
      startClient: async () => {
        starts++;
        throw new Error("no server");
      },
    },
  });
  await session.start(fakeAudioSink().sink);
  await session.ended;

  expect(starts).toBe(1);
  expect(logs.some((l) => l.includes("no server"))).toBe(true);
});

test("each companion runs its own server instance, apart from every other hinge server on the phone", async () => {
  const runs: { pushed: unknown; started: unknown; scid: unknown }[] = [];
  const deps = (): Partial<ScrcpyServerDeps> => {
    const run: { pushed: unknown; started: unknown; scid: unknown } = { pushed: null, started: null, scid: null };
    runs.push(run);
    return {
      readServerJar: async () => new Uint8Array([1]),
      pushServer: async (_adb, _jar, path) => {
        run.pushed = path;
      },
      startClient: async (_adb, options, path) => {
        run.started = path;
        run.scid = (options.value as { scid?: unknown }).scid;
        throw new Error("stop here");
      },
    };
  };
  await companion(deps()).start(fakeAudioSink().sink);
  await companion(deps()).start(fakeAudioSink().sink);

  for (const run of runs) {
    expect(run.scid).toMatch(/^[0-9a-f]{1,8}$/);
    expect(run.pushed).toBe(`/data/local/tmp/hinge-scrcpy-${run.scid as string}.jar`);
    expect(run.started).toBe(run.pushed);
  }
  expect(runs[0].scid).not.toBe(runs[1].scid);
});
