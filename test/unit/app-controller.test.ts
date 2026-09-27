import { expect, test } from "vitest";
import { bindSource, DeviceSource, type ConnectedPhone, type DeviceWatcher, type FoldMonitorStarter, type NotificationMirrorStarter, type PortLike } from "../../src/main/app-controller";
import type { MediaSource, MediaSink } from "../../src/main/media-source";
import { ScrcpySession, type ScrcpyServerDeps } from "../../src/main/scrcpy-session";
import { DEFAULT_STREAM_SETTINGS } from "../../src/main/scrcpy-init";
import type { TransferDeps } from "../../src/main/transfers";
import type { ControlIntent, MainToRenderer, RendererToMain, SessionStatus, TransferProgress } from "../../src/shared/wire";
import type { DeviceSummary } from "../../src/main/transport";

test("forwards source events to the port with transferables and routes control back", async () => {
  const posted: [MainToRenderer, ArrayBuffer[]][] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m, t) => posted.push([m, t]), onMessage: (fn) => { handler = fn; } };
  const got: ControlIntent[] = [];
  let sink!: MediaSink;
  const source: MediaSource = { start: async (s) => { sink = s; }, control: (i) => got.push(i), stop: async () => {} };
  bindSource(source, port);
  handler({ kind: "ready" });
  await Promise.resolve();
  const data = new Uint8Array([1, 2]);
  sink.videoPacket({ type: "configuration", data });
  expect(posted[0]).toEqual([{ kind: "video-packet", packet: { type: "configuration", data } }, [data.buffer]]);
  handler({ kind: "control", intent: { type: "text", text: "x" } });
  expect(got).toEqual([{ type: "text", text: "x" }]);
});

test("source starts only after the renderer says ready", async () => {
  let started = false;
  let handler: (m: RendererToMain) => void = () => {};
  bindSource({ start: async () => { started = true; }, control: () => {}, stop: async () => {} }, { postMessage: () => {}, onMessage: (fn) => { handler = fn; } });
  expect(started).toBe(false);
  handler({ kind: "ready" });
  expect(started).toBe(true);
});

test("posts an error status when the source fails to start", async () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } };
  bindSource({ start: async () => { throw new Error("boom"); }, control: () => {}, stop: async () => {} }, port);
  handler({ kind: "ready" });
  await flush();
  expect(posted).toContainEqual({ kind: "status", status: { state: "error", message: "Error: boom" } });
});

test("appends a short log hint to error statuses when a log path is given", async () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } };
  bindSource(
    { start: async () => { throw new Error("boom"); }, control: () => {}, stop: async () => {} },
    port,
    { logPath: "/home/user/.config/hinge/logs/hinge.log" },
  );
  handler({ kind: "ready" });
  await flush();
  expect(posted).toContainEqual({ kind: "status", status: { state: "error", message: "Error: boom (log: hinge.log)" } });
});

test("a second ready (renderer reload) replays the last video-start and configuration packet instead of restarting the source", async () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } };
  let startCalls = 0;
  let sink!: MediaSink;
  const source: MediaSource = { start: async (s) => { startCalls++; sink = s; }, control: () => {}, stop: async () => {} };
  bindSource(source, port);

  handler({ kind: "ready" });
  await flush();
  sink.videoStart({ codecId: 1, width: 2, height: 3, deviceName: null });
  sink.videoPacket({ type: "configuration", data: new Uint8Array([9, 9]) });
  sink.videoPacket({ type: "data", keyframe: true, pts: 1, data: new Uint8Array([1]) });

  posted.length = 0;
  handler({ kind: "ready" });
  await flush();

  expect(startCalls).toBe(1);
  expect(posted).toEqual([
    { kind: "video-start", info: { codecId: 1, width: 2, height: 3, deviceName: null } },
    { kind: "video-packet", packet: { type: "configuration", data: new Uint8Array([9, 9]) } },
  ]);
});

test("forwards audio events to the port and replays the last audio-start and configuration packet on a second ready", async () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } };
  let sink!: MediaSink;
  const source: MediaSource = { start: async (s) => { sink = s; }, control: () => {}, stop: async () => {} };
  bindSource(source, port);
  handler({ kind: "ready" });
  await flush();

  sink.audioStart!({ codec: "opus", sampleRate: 48000, channels: 2 });
  sink.audioPacket!({ type: "configuration", data: new Uint8Array([1, 2]) });
  sink.audioPacket!({ type: "data", pts: 1, data: new Uint8Array([3]) });

  posted.length = 0;
  handler({ kind: "ready" });
  await flush();

  expect(posted).toEqual([
    { kind: "audio-start", info: { codec: "opus", sampleRate: 48000, channels: 2 } },
    { kind: "audio-packet", packet: { type: "configuration", data: new Uint8Array([1, 2]) } },
  ]);
});

test("audioEnd forwards the reason and clears the replay state so a later ready does not resurrect a dead audio stream", async () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } };
  let sink!: MediaSink;
  const source: MediaSource = { start: async (s) => { sink = s; }, control: () => {}, stop: async () => {} };
  bindSource(source, port);
  handler({ kind: "ready" });
  await flush();

  sink.audioStart!({ codec: "opus", sampleRate: 48000, channels: 2 });
  sink.audioEnd!("unsupported");
  expect(posted).toContainEqual({ kind: "audio-end", reason: "unsupported" });

  posted.length = 0;
  handler({ kind: "ready" });
  await flush();

  expect(posted.some((m) => m.kind === "audio-start" || m.kind === "audio-packet")).toBe(false);
});

test("forwards transfer-progress from the sink to the port, and routes a drop-files message to the source's transfer()", async () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } };
  const transferred: string[][] = [];
  let sink!: MediaSink;
  const source: MediaSource = {
    start: async (s) => { sink = s; },
    control: () => {},
    transfer: (paths) => transferred.push(paths),
    stop: async () => {},
  };
  bindSource(source, port);
  handler({ kind: "ready" });
  await flush();

  handler({ kind: "drop-files", paths: ["/tmp/a.apk", "/tmp/b.png"] });
  expect(transferred).toEqual([["/tmp/a.apk", "/tmp/b.png"]]);

  sink.transferProgress!({ id: "t1", name: "a.apk", kind: "install", state: "running", bytesWritten: 1, totalBytes: 2 });
  expect(posted).toContainEqual({
    kind: "transfer-progress",
    progress: { id: "t1", name: "a.apk", kind: "install", state: "running", bytesWritten: 1, totalBytes: 2 },
  });
});

test("pop-out and app requests from the main window go to onRendererMessage, never to the source's control", () => {
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: () => {}, onMessage: (fn) => { handler = fn; } };
  const controls: ControlIntent[] = [];
  const received: RendererToMain[] = [];
  bindSource({ start: async () => {}, control: (i) => controls.push(i), stop: async () => {} }, port, { onRendererMessage: (m) => received.push(m) });

  const requests: RendererToMain[] = [
    { kind: "popout-open", pkg: "com.example.chat" },
    { kind: "popout-current" },
    { kind: "apps-request" },
    { kind: "create-shortcut", pkg: "com.example.chat" },
  ];
  for (const m of requests) handler(m);
  handler({ kind: "viewport", width: 1, height: 2, dpr: 1 });
  handler({ kind: "retry" });

  expect(received).toEqual(requests);
  expect(controls).toEqual([]);
});

test("DeviceSource.transfer() forwards to the current session and is a no-op with no session connected", async () => {
  const watcher = fakeWatcher();
  const transferred: string[][] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: (): MediaSource => ({
      start: async () => {},
      control: () => {},
      transfer: (paths) => transferred.push(paths),
      stop: async () => {},
    }),
  });
  const { sink } = fakeSink();
  await source.start(sink);

  source.transfer(["/tmp/nowhere.txt"]);
  expect(transferred).toEqual([]);

  watcher.emit([device("USB1")]);
  await flush();
  source.transfer(["/tmp/here.txt"]);
  expect(transferred).toEqual([["/tmp/here.txt"]]);
});

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeSink(): { sink: MediaSink; statuses: SessionStatus[] } {
  const statuses: SessionStatus[] = [];
  const sink: MediaSink = {
    videoStart: () => {},
    videoPacket: () => {},
    videoEnd: () => {},
    status: (s) => statuses.push(s),
  };
  return { sink, statuses };
}

function device(serial: string, transport: DeviceSummary["transport"] = "usb"): DeviceSummary {
  return { serial, state: "device", model: null, device: null, transport };
}

class FakeSession implements MediaSource {
  stopped = false;
  startCalls = 0;
  #sink: MediaSink | null = null;
  #resolveEnded!: () => void;
  readonly ended: Promise<void> = new Promise((resolve) => {
    this.#resolveEnded = resolve;
  });

  async start(sink: MediaSink): Promise<void> {
    this.startCalls++;
    this.#sink = sink;
  }

  control(): void {}

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** Marks this session as having reached the phone's video stream. */
  streamed(): void {
    this.#sink?.status({ state: "streaming", serial: "unused", model: null, deviceId: "unused" });
  }

  fail(message: string): void {
    this.#sink?.status({ state: "error", message });
  }

  end(): void {
    this.#resolveEnded();
  }
}

interface FakeWatcher {
  host: DeviceWatcher;
  emit: (devices: DeviceSummary[]) => void;
  fail: (err: Error) => void;
  watchCalls: number;
  ensureServerCalls: number;
}

function fakeWatcher(): FakeWatcher {
  let onChange: (devices: DeviceSummary[]) => void = () => {};
  let onError: ((err: Error) => void) | undefined;
  const watcher: FakeWatcher = {
    host: {
      ensureServer: async () => {
        watcher.ensureServerCalls++;
        return "existing";
      },
      open: async () => ({}) as never,
      watch: async (onChangeFn, onErrorFn) => {
        watcher.watchCalls++;
        onChange = onChangeFn;
        onError = onErrorFn;
        return async () => {};
      },
    },
    emit: (devices) => onChange(devices),
    fail: (err) => onError?.(err),
    watchCalls: 0,
    ensureServerCalls: 0,
  };
  return watcher;
}

test("switches from the USB device to the TCP device when USB disappears", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  const sessions: FakeSession[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  const usb = device("USB1", "usb");
  const tcp = device("1.2.3.4:5555", "tcp");
  watcher.emit([usb, tcp]);
  await flush();
  expect(opened).toEqual(["USB1"]);
  expect(sessions).toHaveLength(1);

  watcher.emit([tcp]);
  await flush();
  expect(opened).toEqual(["USB1", "1.2.3.4:5555"]);
  expect(sessions).toHaveLength(2);
  expect(sessions[0].stopped).toBe(true);
});

test("reconnects when the session ends on its own while the device stays listed", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  const sessions: FakeSession[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  expect(sessions).toHaveLength(1);

  sessions[0].streamed();
  sessions[0].end();
  await flush();
  expect(opened).toEqual(["USB1", "USB1"]);
  expect(sessions).toHaveLength(2);
});

test("does not reconnect immediately when a session ends without ever streaming; backs off with the error visible", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  const sessions: FakeSession[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  expect(sessions).toHaveLength(1);

  sessions[0].fail("class not found");
  sessions[0].end();
  await flush();

  // The failure went through the backoff (delay actually invoked, not skipped)
  // and the error stayed on screen with a countdown, rather than being
  // silently replaced by an immediate reconnect.
  expect(delays).toEqual([1000]);
  expect(statuses).toContainEqual({ state: "error", message: "class not found (retrying in 1s)" });
  expect(opened).toEqual(["USB1", "USB1"]);
  expect(sessions).toHaveLength(2);
});

test("session-start backoff climbs 1/2/4/8/15s across repeated non-streaming failures", async () => {
  const watcher = fakeWatcher();
  const sessions: FakeSession[] = [];
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();

  for (let i = 0; i < 6; i++) {
    sessions.at(-1)!.fail("boom");
    sessions.at(-1)!.end();
    await flush();
  }

  expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
});

test("a device-list change cancels a pending session-start retry and resets the backoff", async () => {
  const watcher = fakeWatcher();
  const sessions: FakeSession[] = [];
  let signalSeen: AbortSignal | undefined;
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    delay: (_ms, signal) =>
      new Promise((resolve) => {
        signalSeen = signal;
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  sessions[0].fail("boom");
  sessions[0].end();
  await flush();
  expect(signalSeen?.aborted).toBeFalsy();

  // The device disappears: the pending retry is cancelled, not left to fire later.
  watcher.emit([]);
  await flush();
  expect(signalSeen?.aborted).toBe(true);
  expect(sessions).toHaveLength(1);
});

test("a successful stream resets the session-start backoff for the next failure", async () => {
  const watcher = fakeWatcher();
  const sessions: FakeSession[] = [];
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();

  // A fails, backs off at 1s; B (its replacement) also fails without
  // streaming, so the ladder climbs to 2s.
  sessions[0].fail("first failure");
  sessions[0].end();
  await flush();
  sessions[1].fail("second failure");
  sessions[1].end();
  await flush();
  expect(delays).toEqual([1000, 2000]);
  expect(sessions).toHaveLength(3);

  // C streams successfully, then later ends (e.g. the phone was unplugged):
  // that is an immediate reconnect, not a backed-off retry.
  sessions[2].streamed();
  sessions[2].end();
  await flush();
  expect(delays).toEqual([1000, 2000]);
  expect(sessions).toHaveLength(4);

  // D fails without streaming: the ladder restarted at 1s because C streamed.
  sessions[3].fail("third failure");
  sessions[3].end();
  await flush();
  expect(delays).toEqual([1000, 2000, 1000]);
});

test("keeps the current session's serial when it is still listed, even as its mDNS duplicate flickers", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  const sessions: FakeSession[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  const tcp = device("10.0.0.23:34065", "tcp");
  const mdns = device("adb-R3GYC0638KH-rizcTw._adb-tls-connect._tcp", "mdns");

  watcher.emit([tcp, mdns]);
  await flush();
  expect(opened).toEqual(["10.0.0.23:34065"]);
  expect(sessions).toHaveLength(1);

  // The mDNS entry for the same phone disappears, then reappears: the
  // session tied to the tcp serial must not be torn down and restarted.
  watcher.emit([tcp]);
  await flush();
  watcher.emit([tcp, mdns]);
  await flush();

  expect(opened).toEqual(["10.0.0.23:34065"]);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].stopped).toBe(false);
});

test("does not start a session when the device disappears during open", async () => {
  const watcher = fakeWatcher();
  let resolveOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  const sessions: FakeSession[] = [];
  watcher.host.open = async () => {
    await openGate;
    return {} as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();

  watcher.emit([]);
  await flush();
  expect(statuses.at(-1)).toEqual({ state: "no-device" });

  resolveOpen();
  await flush();
  expect(sessions).toHaveLength(0);
});

test("stop during connect starts nothing", async () => {
  const watcher = fakeWatcher();
  let resolveOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  const sessions: FakeSession[] = [];
  watcher.host.open = async () => {
    await openGate;
    return {} as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();

  await source.stop();
  resolveOpen();
  await flush();
  expect(sessions).toHaveLength(0);
});

test("reconnects device tracking after the observer errors, with a backoff", async () => {
  const watcher = fakeWatcher();
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);
  expect(watcher.watchCalls).toBe(1);

  watcher.fail(new Error("observer died"));
  await flush();

  expect(statuses).toContainEqual({
    state: "error",
    message: "Lost connection to the adb server, reconnecting...",
  });
  expect(delays).toEqual([1000]);
  expect(watcher.ensureServerCalls).toBe(1);
  expect(watcher.watchCalls).toBe(2);

  watcher.emit([device("USB1")]);
  await flush();
});

test("backs off up to 8s across repeated reconnect failures, then recovers", async () => {
  const watcher = fakeWatcher();
  const delays: number[] = [];
  let ensureServerCalls = 0;
  watcher.host.ensureServer = async () => {
    ensureServerCalls++;
    if (ensureServerCalls <= 4) throw new Error(`server not up yet (${ensureServerCalls})`);
    return "existing";
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);
  expect(watcher.watchCalls).toBe(1);

  watcher.fail(new Error("observer died"));
  await flush();

  expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
  expect(ensureServerCalls).toBe(5);
  expect(watcher.watchCalls).toBe(2);
});

test("stop cancels a pending reconnect backoff delay and starts no further attempts", async () => {
  const watcher = fakeWatcher();
  let signalSeen: AbortSignal | undefined;
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    delay: (_ms, signal) =>
      new Promise((resolve) => {
        signalSeen = signal;
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.fail(new Error("observer died"));
  await flush();
  expect(watcher.ensureServerCalls).toBe(0);

  await source.stop();
  await flush();

  expect(signalSeen?.aborted).toBe(true);
  expect(watcher.ensureServerCalls).toBe(0);
  expect(watcher.watchCalls).toBe(1);
});

test("stop during an in-flight ensureServer/watch reconnect leaves no active watch", async () => {
  const watcher = fakeWatcher();
  let resolveEnsure!: () => void;
  const ensureGate = new Promise<void>((resolve) => {
    resolveEnsure = resolve;
  });
  watcher.host.ensureServer = async () => {
    watcher.ensureServerCalls++;
    await ensureGate;
    return "existing";
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    delay: async () => {},
  });
  const { sink } = fakeSink();
  await source.start(sink);
  expect(watcher.watchCalls).toBe(1);

  watcher.fail(new Error("observer died"));
  await flush();
  expect(watcher.ensureServerCalls).toBe(1);

  await source.stop();
  resolveEnsure();
  await flush();

  expect(watcher.watchCalls).toBe(1);
});

test("does not start two sessions when the device list flips before the first open resolves", async () => {
  const watcher = fakeWatcher();
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const gateFor = (serial: string) => {
    let gate = gates.get(serial);
    if (!gate) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      gate = { promise, resolve };
      gates.set(serial, gate);
    }
    return gate;
  };
  const sessionsFor: string[] = [];
  watcher.host.open = async (serial) => {
    await gateFor(serial).promise;
    return {} as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: (dev) => {
      sessionsFor.push(dev.serial);
      return new FakeSession();
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("A")]);
  await flush();
  watcher.emit([device("B")]);
  await flush();

  // A's stale open resolves and is discarded; a redundant re-emit of the same
  // device list (e.g. an unrelated device add/remove elsewhere) follows before
  // B's open resolves.
  gateFor("A").resolve();
  await flush();
  watcher.emit([device("B")]);
  await flush();

  gateFor("B").resolve();
  await flush();

  expect(sessionsFor).toEqual(["B"]);
});

test("continues backing off when watch() itself fails during reconnect, even though ensureServer succeeds", async () => {
  const watcher = fakeWatcher();
  const delays: number[] = [];
  let onError: ((err: Error) => void) | undefined;
  let watchCallCount = 0;
  watcher.host.watch = async (onChangeFn, onErrorFn) => {
    watchCallCount++;
    onError = onErrorFn;
    // The 1st call (initial start()) succeeds. The 2nd-4th calls (reconnect
    // attempts) fail. The 5th call succeeds.
    if (watchCallCount >= 2 && watchCallCount <= 4) {
      throw new Error(`watch failed (${watchCallCount})`);
    }
    return async () => {};
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);
  expect(watchCallCount).toBe(1);

  onError?.(new Error("observer died"));
  await flush();

  expect(delays).toEqual([1000, 2000, 4000, 8000]);
  expect(watchCallCount).toBe(5);
  expect(watcher.ensureServerCalls).toBe(4);
  expect(statuses).toContainEqual({
    state: "error",
    message: "Lost connection to the adb server, reconnecting...",
  });
});

test("wraps the sink once via recordSink so every session's session.start() sees the recording sink", async () => {
  const watcher = fakeWatcher();
  const sessionSinks: MediaSink[] = [];
  const wrapCalls: MediaSink[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: (): MediaSource => ({
      start: async (sink) => {
        sessionSinks.push(sink);
      },
      control: () => {},
      stop: async () => {},
    }),
    recordSink: (sink) => {
      wrapCalls.push(sink);
      return { ...sink, postureLine: () => {} };
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);
  expect(wrapCalls).toEqual([sink]);

  watcher.emit([device("USB1")]);
  await flush();
  expect(sessionSinks).toHaveLength(1);
  expect(sessionSinks[0]).not.toBe(sink);
  expect(typeof sessionSinks[0].postureLine).toBe("function");
});

test("starts the fold monitor when a session connects (even without recording) and stops it when that session is torn down", async () => {
  const watcher = fakeWatcher();
  let starts = 0;
  let stops = 0;
  let seenAdb: unknown;
  let seenSink: MediaSink | undefined;
  const foldMonitor: FoldMonitorStarter = async (adb, sink) => {
    starts++;
    seenAdb = adb;
    seenSink = sink;
    return async () => {
      stops++;
    };
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    foldMonitor,
  });
  const openedAdb = { marker: "adb" };
  watcher.host.open = async () => openedAdb as never;
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  expect(starts).toBe(1);
  expect(seenAdb).toBe(openedAdb);
  expect(seenSink).toBe(sink);

  watcher.emit([]);
  await flush();
  expect(stops).toBe(1);
});

test("the fold monitor sees the recording-wrapped sink when recordSink is set", async () => {
  const watcher = fakeWatcher();
  let seenSink: MediaSink | undefined;
  const foldMonitor: FoldMonitorStarter = async (_adb, sink) => {
    seenSink = sink;
    return async () => {};
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    recordSink: (sink) => ({ ...sink, postureLine: () => {} }),
    foldMonitor,
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  expect(seenSink).not.toBe(sink);
  expect(typeof seenSink?.postureLine).toBe("function");
});

test("a fold monitor that fails to start is best-effort: mirroring still starts and the failure is logged, not shown as an error", async () => {
  const watcher = fakeWatcher();
  const logs: string[] = [];
  const foldMonitor: FoldMonitorStarter = async () => {
    throw new Error("shell spawn failed");
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    foldMonitor,
    log: (line) => logs.push(line),
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();

  expect(statuses.some((s) => s.state === "error")).toBe(false);
  expect(logs.some((l) => l.includes("fold monitor failed to start") && l.includes("shell spawn failed"))).toBe(true);
});

test("stop() stops a running fold monitor", async () => {
  const watcher = fakeWatcher();
  let stops = 0;
  const foldMonitor: FoldMonitorStarter = async () => async () => {
    stops++;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    foldMonitor,
  });
  const { sink } = fakeSink();
  await source.start(sink);
  watcher.emit([device("USB1")]);
  await flush();

  await source.stop();
  expect(stops).toBe(1);
});

test("starts the notification mirror alongside the fold monitor when a session connects, and stops it when torn down", async () => {
  const watcher = fakeWatcher();
  let starts = 0;
  let stops = 0;
  let seenAdb: unknown;
  const notificationMirror: NotificationMirrorStarter = async (adb) => {
    starts++;
    seenAdb = adb;
    return async () => {
      stops++;
    };
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    notificationMirror,
  });
  const openedAdb = { marker: "adb" };
  watcher.host.open = async () => openedAdb as never;
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  expect(starts).toBe(1);
  expect(seenAdb).toBe(openedAdb);

  watcher.emit([]);
  await flush();
  expect(stops).toBe(1);
});

test("a notification mirror that fails to start is best-effort: mirroring still starts and the failure is logged", async () => {
  const watcher = fakeWatcher();
  const logs: string[] = [];
  const notificationMirror: NotificationMirrorStarter = async () => {
    throw new Error("shell spawn failed");
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    notificationMirror,
    log: (line) => logs.push(line),
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();

  expect(statuses.some((s) => s.state === "error")).toBe(false);
  expect(logs.some((l) => l.includes("notification mirror failed to start") && l.includes("shell spawn failed"))).toBe(true);
});

test("stop() stops a running notification mirror", async () => {
  const watcher = fakeWatcher();
  let stops = 0;
  const notificationMirror: NotificationMirrorStarter = async () => async () => {
    stops++;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    notificationMirror,
  });
  const { sink } = fakeSink();
  await source.start(sink);
  watcher.emit([device("USB1")]);
  await flush();

  await source.stop();
  expect(stops).toBe(1);
});

test("a stopped session's late ended cannot detach a newer session started on the same serial", async () => {
  const watcher = fakeWatcher();
  const sessions: FakeSession[] = [];
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  expect(sessions).toHaveLength(1);
  const stale = sessions[0];

  watcher.emit([]);
  await flush();
  expect(stale.stopped).toBe(true);

  watcher.emit([device("USB1")]);
  await flush();
  expect(sessions).toHaveLength(2);
  const current = sessions[1];

  // The stale session's ended promise resolves late, after it was already
  // superseded by `current` on the identical serial.
  stale.end();
  await flush();

  expect(sessions).toHaveLength(2);
  expect(current.stopped).toBe(false);
  expect(delays).toEqual([]);
  expect(statuses.filter((s) => s.state === "error")).toEqual([]);
});

test("a run superseded by a same-serial reconnect during host.open() does not overwrite the newer run's session", async () => {
  const watcher = fakeWatcher();
  const sessions: FakeSession[] = [];
  let openCalls = 0;
  let releaseFirstOpen!: () => void;
  watcher.host.open = async (serial) => {
    openCalls++;
    if (openCalls === 1) {
      await new Promise<void>((resolve) => {
        releaseFirstOpen = resolve;
      });
    }
    return { marker: serial, call: openCalls } as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  // Run A starts (host.open() gated), then the device drops and reappears
  // on the identical serial before A's open() resolves: teardown, then a
  // fresh run B whose open() resolves immediately.
  watcher.emit([device("USB1")]);
  await flush();
  expect(openCalls).toBe(1);

  watcher.emit([]);
  await flush();
  watcher.emit([device("USB1")]);
  await flush();
  expect(openCalls).toBe(2);
  expect(sessions).toHaveLength(1);
  const runB = sessions[0];

  // Run A's gated open() now resolves late: it must not create a second
  // session or otherwise clobber run B.
  releaseFirstOpen();
  await flush();

  expect(sessions).toHaveLength(1);
  expect(runB.stopped).toBe(false);

  await source.stop();
  expect(runB.stopped).toBe(true);
});

test("a fold monitor still starting when its run is superseded by a same-serial reconnect is stopped immediately instead of leaking into #stopPosture", async () => {
  const watcher = fakeWatcher();
  const sessions: FakeSession[] = [];
  const monitorStops: string[] = [];
  let monitorCall = 0;
  let releaseFirstMonitor!: () => void;
  const foldMonitor: FoldMonitorStarter = async () => {
    monitorCall++;
    const id = `monitor-${monitorCall}`;
    if (monitorCall === 1) {
      await new Promise<void>((resolve) => {
        releaseFirstMonitor = resolve;
      });
    }
    return async () => {
      monitorStops.push(id);
    };
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    foldMonitor,
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();
  expect(monitorCall).toBe(1);
  // The monitor is not awaited: the session is created immediately regardless.
  expect(sessions).toHaveLength(1);

  // The device drops and reappears on the identical serial: run A's session
  // is torn down (its monitor is still pending, not yet assigned to
  // #stopPosture) and a fresh run B connects with its own monitor.
  watcher.emit([]);
  await flush();
  watcher.emit([device("USB1")]);
  await flush();
  expect(monitorCall).toBe(2);
  expect(sessions).toHaveLength(2);

  // Run A's gated monitor now resolves late: it must be stopped immediately,
  // not assigned over run B's live monitor.
  releaseFirstMonitor();
  await flush();
  expect(monitorStops).toEqual(["monitor-1"]);

  await source.stop();
  expect(monitorStops).toEqual(["monitor-1", "monitor-2"]);
});

test("host.open failures are logged and get the same backoff retry as an exhausted session-start ladder", async () => {
  const watcher = fakeWatcher();
  const delays: number[] = [];
  const logs: string[] = [];
  let openCalls = 0;
  watcher.host.open = async () => {
    openCalls++;
    throw new Error("device offline");
  };
  // A delay that never resolves on its own (only on abort) keeps the retry
  // from automatically firing again and re-triggering the always-failing
  // open() forever; the test only needs to observe the first retry.
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    delay: (ms, signal) => {
      delays.push(ms);
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    log: (l) => logs.push(l),
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1")]);
  await flush();

  expect(openCalls).toBe(1);
  expect(logs.some((l) => l.includes("device offline"))).toBe(true);
  expect(delays).toEqual([1000]);
  expect(statuses).toContainEqual({ state: "error", message: "Error: device offline (retrying in 1s)" });
});

test("stop while host.watch() itself is in flight disposes the subscription it just installed", async () => {
  const watcher = fakeWatcher();
  let resolveWatch!: (dispose: () => Promise<void>) => void;
  const watchGate = new Promise<() => Promise<void>>((resolve) => {
    resolveWatch = resolve;
  });
  let disposeCalls = 0;
  watcher.host.watch = async () => watchGate;

  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession() });
  const { sink } = fakeSink();
  const startPromise = source.start(sink);
  await flush();

  await source.stop();

  resolveWatch(async () => {
    disposeCalls++;
  });
  await flush();
  await startPromise;

  expect(disposeCalls).toBe(1);
});

test("a second ready (renderer reload) also replays the last posture reading after the video", async () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } };
  let sink!: MediaSink;
  bindSource({ start: async (s) => { sink = s; }, control: () => {}, stop: async () => {} }, port);

  handler({ kind: "ready" });
  await flush();
  sink.videoStart({ codecId: 1, width: 2, height: 3, deviceName: null });
  sink.posture?.({ stateId: 2, posture: "half", rotation: 0 });
  sink.posture?.({ stateId: 3, posture: "open", rotation: 1 });

  posted.length = 0;
  handler({ kind: "ready" });
  await flush();

  expect(posted.map((m) => m.kind)).toEqual(["video-start", "posture"]);
  expect(posted[1]).toEqual({ kind: "posture", reading: { stateId: 3, posture: "open", rotation: 1 } });
});

function fakeWireless(): { wireless: import("../../src/main/wireless").WirelessDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { pair: [], connect: [], disconnect: [], mdnsServices: [], setTcpIpPort: [], wlanIp: [] };
  return {
    calls,
    wireless: {
      pair: async (hostPort, code) => {
        calls.pair.push([hostPort, code]);
      },
      connect: async (address) => {
        calls.connect.push([address]);
      },
      disconnect: async (address) => {
        calls.disconnect.push([address]);
      },
      mdnsServices: async () => {
        calls.mdnsServices.push([]);
        return [];
      },
      setTcpIpPort: async (adb, port) => {
        calls.setTcpIpPort.push([adb, port]);
      },
      wlanIp: async (adb) => {
        calls.wlanIp.push([adb]);
        return "192.168.1.50";
      },
    },
  };
}

test("a TCP device disappearing triggers wireless.connect on the 1/2/4/8/15s backoff until it succeeds, once it has streamed at least once", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  const delays: number[] = [];
  let connectAttempts = 0;
  wireless.connect = async () => {
    connectAttempts++;
    if (connectAttempts < 3) throw new Error("still unreachable");
  };
  const sessions: FakeSession[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    wireless,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  const tcp = device("10.0.0.5:5555", "tcp");
  watcher.emit([tcp]);
  await flush();
  sessions[0].streamed();

  watcher.emit([]); // the phone drops off Wi-Fi
  await flush();

  expect(delays).toEqual([1000, 2000, 4000]);
  expect(connectAttempts).toBe(3);
});

test("TCP reconnect backoff caps at 15s and keeps repeating at 15s, not climbing forever", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  const delays: number[] = [];
  let connectAttempts = 0;
  wireless.connect = async () => {
    connectAttempts++;
    if (connectAttempts < 6) throw new Error("still unreachable");
  };
  const sessions: FakeSession[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    wireless,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("10.0.0.5:5555", "tcp")]);
  await flush();
  sessions[0].streamed();

  watcher.emit([]);
  await flush();

  expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  expect(connectAttempts).toBe(6);
});

test("a stale lastDevice that never streamed this run does not trigger TCP reconnect at launch", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    preferred: "10.0.0.9:5555",
    createSession: () => new FakeSession(),
    wireless,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  // The remembered device is not in the first device list at all: never
  // having streamed this run, it must not start a reconnect loop.
  watcher.emit([]);
  await flush();

  expect(delays).toEqual([]);
});

test("TCP reconnect is not attempted for a USB device dropping, and stops once the device list changes again", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => new FakeSession(),
    wireless,
    delay: (_ms, signal) =>
      new Promise((resolve) => {
        delays.push(_ms);
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1", "usb")]);
  await flush();
  watcher.emit([]);
  await flush();
  expect(delays).toEqual([]); // USB dropping never starts a wireless reconnect loop

  const tcpSessions: FakeSession[] = [];
  const tcpSource = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      tcpSessions.push(s);
      return s;
    },
    wireless,
    delay: (ms, signal) =>
      new Promise((resolve) => {
        delays.push(ms);
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  const { sink: sink2 } = fakeSink();
  await tcpSource.start(sink2);
  watcher.emit([device("10.0.0.5:5555", "tcp")]);
  await flush();
  tcpSessions[0].streamed();
  watcher.emit([]);
  await flush();
  expect(delays).toEqual([1000]);

  // The device reappears through adb's own tracking before the reconnect
  // loop's delay resolves: the pending wireless.connect attempt is cancelled.
  watcher.emit([device("10.0.0.5:5555", "tcp")]);
  await flush();
  expect(delays).toEqual([1000]); // no further delay scheduled
});

test("chooseDevice() switches the session to a specific already-listed device, overriding the USB-preferred default", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  const sessions: FakeSession[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  const usb = device("USB1", "usb");
  const tcp = device("10.0.0.5:5555", "tcp");
  watcher.emit([usb, tcp]);
  await flush();
  expect(opened).toEqual(["USB1"]); // USB wins by default

  source.chooseDevice("10.0.0.5:5555");
  await flush();
  expect(opened).toEqual(["USB1", "10.0.0.5:5555"]);
  expect(sessions[0].stopped).toBe(true);
});

test("handleDeviceCommand('list') returns the deduped device list", async () => {
  const watcher = fakeWatcher();
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession() });
  const { sink } = fakeSink();
  await source.start(sink);

  const tcp = { serial: "10.0.0.5:5555", state: "device", model: "Pixel 8", device: "shiba", transport: "tcp" as const };
  const mdns = { serial: "adb-x._adb-tls-connect._tcp", state: "device", model: "Pixel 8", device: "shiba", transport: "mdns" as const };
  watcher.emit([tcp, mdns]);
  await flush();

  const result = await source.handleDeviceCommand!({ type: "list" });
  expect(result).toEqual({ type: "list", devices: [tcp] });
});

test("handleDeviceCommand('pair') pairs and, once mDNS resolves a connect service, switches the session to it", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const { wireless, calls } = fakeWireless();
  wireless.mdnsServices = async () => [{ name: "x", service: "_adb-tls-connect._tcp", address: "192.168.1.42:5000" }];
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  const result = await source.handleDeviceCommand!({ type: "pair", hostPort: "192.168.1.42:37251", code: "123456" });
  expect(calls.pair).toEqual([["192.168.1.42:37251", "123456"]]);
  expect(result).toEqual({ type: "pair", ok: true, connectedAddress: "192.168.1.42:5000" });

  watcher.emit([device("192.168.1.42:5000", "tcp")]);
  await flush();
  expect(opened).toEqual(["192.168.1.42:5000"]);
});

test("handleDeviceCommand('switch-to-wifi') opens the USB device, drives switchDeviceToWifi, closes the opened adb, and moves the session to the new address", async () => {
  const watcher = fakeWatcher();
  let closeCalls = 0;
  const openedAdb = { marker: "usb-adb", close: async () => { closeCalls++; } };
  const opened: unknown[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return openedAdb as never;
  };
  const { wireless, calls } = fakeWireless();
  const sessions: FakeSession[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    wireless,
  });
  const { sink } = fakeSink();
  await source.start(sink);

  const result = await source.handleDeviceCommand!({ type: "switch-to-wifi", serial: "USB1" });
  expect(calls.wlanIp).toEqual([[openedAdb]]);
  expect(calls.setTcpIpPort).toEqual([[openedAdb, 5555]]);
  expect(result).toEqual({ type: "switch-to-wifi", ok: true, address: "192.168.1.50:5555" });
  expect(closeCalls).toBe(1);

  // The session moved to the new wireless address, not left waiting on USB1.
  watcher.emit([device("192.168.1.50:5555", "tcp")]);
  await flush();
  expect(opened).toEqual(["USB1", "192.168.1.50:5555"]);
});

test("handleDeviceCommand('switch-to-wifi') refuses a non-USB serial", async () => {
  const watcher = fakeWatcher();
  const { wireless, calls } = fakeWireless();
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  const result = await source.handleDeviceCommand!({ type: "switch-to-wifi", serial: "10.0.0.5:5555" });
  expect(result).toEqual({ type: "switch-to-wifi", ok: false, address: null, message: expect.stringContaining("USB") });
  expect(calls.wlanIp).toEqual([]);
});

test("handleDeviceCommand('disconnect') disconnects a wireless device but refuses a USB one", async () => {
  const watcher = fakeWatcher();
  const { wireless, calls } = fakeWireless();
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  const tcpResult = await source.handleDeviceCommand!({ type: "disconnect", serial: "10.0.0.5:5555" });
  expect(calls.disconnect).toEqual([["10.0.0.5:5555"]]);
  expect(tcpResult).toEqual({ type: "disconnect", ok: true });

  const usbResult = await source.handleDeviceCommand!({ type: "disconnect", serial: "USB1" });
  if (usbResult.type !== "disconnect") throw new Error("type");
  expect(usbResult.ok).toBe(false);
  expect(calls.disconnect).toEqual([["10.0.0.5:5555"]]);
});

test("handleDeviceCommand('disconnect') reports failure when wireless.disconnect rejects, instead of throwing", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  wireless.disconnect = async () => {
    throw new Error("device already gone");
  };
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  const result = await source.handleDeviceCommand!({ type: "disconnect", serial: "10.0.0.5:5555" });
  expect(result).toEqual({ type: "disconnect", ok: false, message: expect.stringContaining("device already gone") });
});

test("an explicit disconnect suppresses TCP reconnect for that serial until the user picks it again", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  const delays: number[] = [];
  const sessions: FakeSession[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    wireless,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  const tcp = device("10.0.0.5:5555", "tcp");
  watcher.emit([tcp]);
  await flush();
  sessions[0].streamed();

  await source.handleDeviceCommand!({ type: "disconnect", serial: "10.0.0.5:5555" });
  watcher.emit([]); // the device list update racing the disconnect
  await flush();

  expect(delays).toEqual([]); // no reconnect loop armed for the serial we just disconnected

  // Even if the (already-disconnected) serial flickers back into the device
  // list before the user picks anything, it must not be auto-selected.
  watcher.emit([tcp]);
  await flush();
  expect(sessions).toHaveLength(1);

  // The user explicitly choosing it again clears the suppression.
  source.chooseDevice("10.0.0.5:5555");
  await flush();
  expect(sessions).toHaveLength(2);
});

test("handleDeviceCommand('connect') on an address not yet listed by adb (the 'ask for the connect port' fallback) calls wireless.connect first, then chooses it", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const { wireless, calls } = fakeWireless();
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  const result = await source.handleDeviceCommand!({ type: "connect", serial: "192.168.1.42:5000" });
  expect(calls.connect).toEqual([["192.168.1.42:5000"]]);
  expect(result).toEqual({ type: "connect", ok: true });

  watcher.emit([device("192.168.1.42:5000", "tcp")]);
  await flush();
  expect(opened).toEqual(["192.168.1.42:5000"]);
});

test("handleDeviceCommand('connect') on an already-listed serial chooses it directly without an extra wireless.connect", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const { wireless, calls } = fakeWireless();
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([device("USB1", "usb"), device("10.0.0.5:5555", "tcp")]);
  await flush();
  expect(opened).toEqual(["USB1"]);

  const result = await source.handleDeviceCommand!({ type: "connect", serial: "10.0.0.5:5555" });
  expect(result).toEqual({ type: "connect", ok: true });
  expect(calls.connect).toEqual([]);
  expect(opened).toEqual(["USB1", "10.0.0.5:5555"]);
});

test("handleDeviceCommand('connect') reports failure when wireless.connect rejects", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  wireless.connect = async () => {
    throw new Error("connection refused");
  };
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  const result = await source.handleDeviceCommand!({ type: "connect", serial: "192.168.1.42:5000" });
  expect(result).toEqual({ type: "connect", ok: false, message: expect.stringContaining("connection refused") });
});

test("chooseDevice() with a real transfer in flight cancels it through the actual adb.sync stream, not just relabels it", async () => {
  function neverEndingReadableStream(): ReadableStream<{ type: "data"; data: Uint8Array }> {
    return new ReadableStream({ start: () => {} });
  }
  function oneShotClient(videoStream: ReadableStream<{ type: "data"; data: Uint8Array }>) {
    return {
      videoStream: Promise.resolve({ metadata: { codec: 1, deviceName: "Pixel" }, width: 100, height: 200, stream: videoStream }),
      audioStream: Promise.resolve({ type: "disabled" }),
      output: new ReadableStream<string>({ start: (c) => c.close() }),
      controller: {},
      close: async () => {},
    };
  }
  const scrcpyDeps: Partial<ScrcpyServerDeps> = {
    readServerJar: async () => new Uint8Array([1]),
    pushServer: async () => {},
    startClient: async () => oneShotClient(neverEndingReadableStream()) as never,
  };
  const pushCancelled = { value: false };
  const bigFile = new ReadableStream<Uint8Array>({ start: () => {} }); // never-ending: the file "content" itself
  const transferDeps: Partial<TransferDeps> = {
    openFile: async () => ({ size: 10_000_000, stream: bigFile }),
    pushFile: async (_path, stream) => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        pushCancelled.value = true;
        throw new Error("write aborted");
      }
    },
    scanFile: async () => {},
    removeFile: async () => {},
  };

  const watcher = fakeWatcher();
  watcher.host.open = async () => ({}) as never;
  const source = new DeviceSource({
    host: watcher.host,
    createSession: (device, adb) =>
      new ScrcpySession({
        adb,
        serial: device.serial,
        model: device.model,
        serverPath: "/vendor/scrcpy-server",
        settings: DEFAULT_STREAM_SETTINGS,
        deps: scrcpyDeps,
        transferDeps,
      }),
  });
  const transfers: TransferProgress[] = [];
  const { sink } = fakeSink();
  sink.transferProgress = (p) => transfers.push(p);
  await source.start(sink);

  // Both devices are already listed, so chooseDevice() below can switch
  // immediately instead of merely remembering a preference for later.
  watcher.emit([device("10.0.0.5:5555", "tcp"), device("192.168.1.9:5555", "tcp")]);
  await flush();
  source.transfer(["/tmp/huge.bin"]);
  await flush();
  expect(transfers.map((p) => p.state)).toEqual(["queued", "running"]);

  // Switching devices mid-transfer must cancel it cleanly through the real
  // stream Tango's adb.sync.write is reading, not just relabel it after the
  // fact while the write keeps running to completion.
  source.chooseDevice("192.168.1.9:5555");
  await flush();
  await flush();

  expect(pushCancelled.value).toBe(true);
  expect(transfers.map((p) => p.state)).toEqual(["queued", "running", "cancelled"]);
  expect(transfers.some((p) => p.state === "done")).toBe(false);
});

test("a device command to a source without device access is answered with an error rather than left hanging", () => {
  const posted: MainToRenderer[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  bindSource({ start: async () => {}, control: () => {}, stop: async () => {} }, { postMessage: (m) => posted.push(m), onMessage: (fn) => { handler = fn; } });
  handler({ kind: "device-command", id: "cmd-1", command: { type: "list" } });
  handler({ kind: "device-command", id: "cmd-2", command: { type: "pair", hostPort: "1.2.3.4:5", code: "123456" } });
  expect(posted).toEqual([
    { kind: "device-command-result", id: "cmd-1", result: { type: "list", devices: [] } },
    { kind: "device-command-result", id: "cmd-2", result: { type: "pair", ok: false, connectedAddress: null, message: "no phone connection in this mode" } },
  ]);
});

test("every status the source reports is also handed to onStatus, for main's own use", async () => {
  const seen: SessionStatus[] = [];
  let handler: (m: RendererToMain) => void = () => {};
  let sink!: MediaSink;
  bindSource({ start: async (s) => { sink = s; }, control: () => {}, stop: async () => {} }, { postMessage: () => {}, onMessage: (fn) => { handler = fn; } }, { onStatus: (s) => seen.push(s) });
  handler({ kind: "ready" });
  await Promise.resolve();
  sink.status({ state: "streaming", serial: "A", model: null, deviceId: "A" });
  expect(seen).toEqual([{ state: "streaming", serial: "A", model: null, deviceId: "A" }]);
});

function phone(serial: string, transport: DeviceSummary["transport"]): DeviceSummary {
  return { serial, state: "device", model: "SM-F966B", device: "q7q", transport };
}

function identifyingWatcher(serialnos: Record<string, string | null>): FakeWatcher & { identified: string[] } {
  const watcher = fakeWatcher() as FakeWatcher & { identified: string[] };
  watcher.identified = [];
  watcher.host.identify = async (serial) => {
    watcher.identified.push(serial);
    return serialnos[serial] ?? null;
  };
  return watcher;
}

test("a remembered identity picks that phone on whatever Wi-Fi port it came back on, over another phone's USB", async () => {
  const watcher = identifyingWatcher({ OTHERUSB: "OTHERUSB", "10.0.0.5:40111": "R5CY" });
  const opened: string[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const created: [string, string][] = [];
  const connected: string[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    preferred: "R5CY",
    createSession: (device, _adb, id) => {
      created.push([device.serial, id]);
      return new FakeSession();
    },
    onConnected: (id) => connected.push(id),
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([phone("OTHERUSB", "usb"), phone("10.0.0.5:40111", "tcp")]);
  await flush();
  await flush();

  expect(opened).toEqual(["10.0.0.5:40111"]);
  expect(created).toEqual([["10.0.0.5:40111", "R5CY"]]);
  expect(connected).toEqual(["R5CY"]);
});

test("ro.serialno is read once per transport, and nothing is picked until every ready transport has an identity", async () => {
  const watcher = fakeWatcher();
  const gates = new Map<string, (serialno: string | null) => void>();
  const asked: string[] = [];
  watcher.host.identify = (serial) => {
    asked.push(serial);
    return new Promise((resolve) => gates.set(serial, resolve));
  };
  const opened: string[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const source = new DeviceSource({ host: watcher.host, preferred: "R5CY", createSession: () => new FakeSession() });
  const { sink } = fakeSink();
  await source.start(sink);

  const list = [phone("OTHERUSB", "usb"), phone("10.0.0.5:40111", "tcp")];
  watcher.emit(list);
  watcher.emit(list);
  await flush();
  expect(asked).toEqual(["OTHERUSB", "10.0.0.5:40111"]);
  expect(opened).toEqual([]);

  gates.get("OTHERUSB")!("OTHERUSB");
  await flush();
  expect(opened).toEqual([]);

  gates.get("10.0.0.5:40111")!("R5CY");
  await flush();
  await flush();
  expect(opened).toEqual(["10.0.0.5:40111"]);

  watcher.emit(list);
  await flush();
  expect(asked).toHaveLength(2);
});

test("a transport whose ro.serialno cannot be read falls back to the serial in its mDNS name", async () => {
  const watcher = identifyingWatcher({});
  watcher.host.identify = async () => {
    throw new Error("shell failed");
  };
  const connected: string[] = [];
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), onConnected: (id) => connected.push(id) });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([phone("adb-R5CY-AbCd._adb-tls-connect._tcp", "mdns")]);
  await flush();
  await flush();
  expect(connected).toEqual(["R5CY"]);
});

test("the settings adoption for a newly identified transport finishes before that phone is connected", async () => {
  const watcher = identifyingWatcher({ "10.0.0.5:40111": "R5CY" });
  const order: string[] = [];
  let finishAdoption!: () => void;
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      order.push("session");
      return new FakeSession();
    },
    onIdentified: (serial, id) => {
      order.push(`identified ${serial} ${id}`);
      return new Promise<void>((resolve) => {
        finishAdoption = resolve;
      });
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);

  watcher.emit([phone("10.0.0.5:40111", "tcp")]);
  await flush();
  expect(order).toEqual(["identified 10.0.0.5:40111 R5CY"]);
  finishAdoption();
  await flush();
  await flush();
  expect(order).toEqual(["identified 10.0.0.5:40111 R5CY", "session"]);
});

test("the list command dedupes by identity and every device-list change is pushed to the sink", async () => {
  const watcher = identifyingWatcher({ "10.0.0.5:40111": "R5CY", "adb-R5CY-AbCd._adb-tls-connect._tcp": "R5CY" });
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession() });
  const pushed: DeviceSummary[][] = [];
  const { sink } = fakeSink();
  sink.devices = (list) => pushed.push(list);
  await source.start(sink);

  const tcp = { ...phone("10.0.0.5:40111", "tcp"), model: null, device: null };
  const mdns = { ...phone("adb-R5CY-AbCd._adb-tls-connect._tcp", "mdns"), model: null, device: null };
  watcher.emit([tcp, mdns]);
  await flush();
  await flush();

  expect(await source.handleDeviceCommand!({ type: "list" })).toEqual({ type: "list", devices: [tcp] });
  expect(pushed.at(-1)).toEqual([tcp]);
  watcher.emit([]);
  await flush();
  expect(pushed.at(-1)).toEqual([]);
});

test("a session that ends on its own is stopped, so its adb sockets and server are released", async () => {
  const watcher = fakeWatcher();
  const sessions: FakeSession[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);
  watcher.emit([device("USB1")]);
  await flush();
  sessions[0].streamed();
  sessions[0].end();
  await flush();
  expect(sessions[0].stopped).toBe(true);
});

function alreadyConnectedError(): Error {
  return Object.assign(new Error("already connected to 10.0.0.5:5555"), { name: "AlreadyConnectedError" });
}

test("the connect command counts adb's 'already connected' as success and moves to that device", async () => {
  const watcher = fakeWatcher();
  const opened: string[] = [];
  watcher.host.open = async (serial) => {
    opened.push(serial);
    return {} as never;
  };
  const { wireless } = fakeWireless();
  wireless.connect = async () => {
    throw alreadyConnectedError();
  };
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);

  expect(await source.handleDeviceCommand!({ type: "connect", serial: "10.0.0.5:5555" })).toEqual({ type: "connect", ok: true });
  watcher.emit([device("USB1"), device("10.0.0.5:5555", "tcp")]);
  await flush();
  expect(opened).toEqual(["10.0.0.5:5555"]);
});

test("the TCP reconnect loop stops at adb's 'already connected' instead of retrying forever", async () => {
  const watcher = fakeWatcher();
  const { wireless } = fakeWireless();
  let attempts = 0;
  wireless.connect = async () => {
    attempts++;
    throw alreadyConnectedError();
  };
  const sessions: FakeSession[] = [];
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    wireless,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink } = fakeSink();
  await source.start(sink);
  watcher.emit([device("10.0.0.5:5555", "tcp")]);
  await flush();
  sessions[0].streamed();
  watcher.emit([]);
  await flush();
  expect(attempts).toBe(1);
  expect(delays).toEqual([1000]);
});

test("disconnect suppresses every transport of the phone and asks adb to drop its ip:port transport", async () => {
  const watcher = identifyingWatcher({ "10.0.0.5:40111": "R5CY", "adb-R5CY-AbCd._adb-tls-connect._tcp": "R5CY" });
  const { wireless, calls } = fakeWireless();
  const sessions: FakeSession[] = [];
  const delays: number[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    wireless,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  const tcp = phone("10.0.0.5:40111", "tcp");
  const mdns = phone("adb-R5CY-AbCd._adb-tls-connect._tcp", "mdns");
  watcher.emit([mdns, tcp]);
  await flush();
  await flush();
  expect(sessions).toHaveLength(1);
  sessions[0].streamed();

  expect(await source.handleDeviceCommand!({ type: "disconnect", serial: mdns.serial })).toEqual({ type: "disconnect", ok: true });
  expect(calls.disconnect).toEqual([["10.0.0.5:40111"]]);
  expect(sessions[0].stopped).toBe(true);
  expect(statuses.at(-1)).toEqual({ state: "no-device" });

  watcher.emit([mdns]);
  await flush();
  expect(sessions).toHaveLength(1);
  expect(delays).toEqual([]);

  source.chooseDevice(mdns.serial);
  await flush();
  expect(sessions).toHaveLength(2);
});

test("disconnect falls back to the mDNS serial when the phone has no ip:port transport", async () => {
  const watcher = fakeWatcher();
  const { wireless, calls } = fakeWireless();
  const source = new DeviceSource({ host: watcher.host, createSession: () => new FakeSession(), wireless });
  const { sink } = fakeSink();
  await source.start(sink);
  watcher.emit([phone("adb-R5CY-AbCd._adb-tls-connect._tcp", "mdns")]);
  await flush();
  await source.handleDeviceCommand!({ type: "disconnect", serial: "adb-R5CY-AbCd._adb-tls-connect._tcp" });
  expect(calls.disconnect).toEqual([["adb-R5CY-AbCd._adb-tls-connect._tcp"]]);
});

function phoneListenerSource(opts: { mainVideo?: boolean } = {}) {
  const watcher = identifyingWatcher({ USB1: "R5CY", USB2: "OTHER" });
  const adbs: Record<string, number> = {};
  watcher.host.open = async (serial) => ({ serial, n: (adbs[serial] = (adbs[serial] ?? 0) + 1) }) as never;
  const sessions: FakeSession[] = [];
  const phones: (ConnectedPhone | null)[] = [];
  const foldStarts: string[] = [];
  const mirrorStarts: string[] = [];
  const source = new DeviceSource({
    host: watcher.host,
    mainVideo: opts.mainVideo,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    onPhone: (p) => phones.push(p),
    foldMonitor: async (adb) => {
      foldStarts.push((adb as unknown as { serial: string }).serial);
      return async () => {};
    },
    notificationMirror: async (adb) => {
      mirrorStarts.push((adb as unknown as { serial: string }).serial);
      return async () => {};
    },
  });
  return { watcher, source, sessions, phones, foldStarts, mirrorStarts };
}

function serials(phones: (ConnectedPhone | null)[]): (string | null)[] {
  return phones.map((p) => p?.serial ?? null);
}

test("with the main video off, a connected phone is announced and gets its fold monitor and notification mirror, but no video session", async () => {
  const { watcher, source, sessions, phones, foldStarts, mirrorStarts } = phoneListenerSource({ mainVideo: false });
  const { sink, statuses } = fakeSink();
  await source.start(sink);

  watcher.emit([phone("USB1", "usb")]);
  await flush();
  await flush();

  expect(sessions).toHaveLength(0);
  expect(phones).toEqual([{ adb: { serial: "USB1", n: 1 }, serial: "USB1", deviceId: "R5CY", model: "SM-F966B" }]);
  expect(foldStarts).toEqual(["USB1"]);
  expect(mirrorStarts).toEqual(["USB1"]);
  expect(statuses).toEqual([{ state: "connecting", serial: "USB1" }]);
  await source.stop();
});

test("turning the main video on starts one session for the connected phone, and turning it off stops it without dropping the phone", async () => {
  const { watcher, source, sessions, phones } = phoneListenerSource({ mainVideo: false });
  await source.start(fakeSink().sink);
  watcher.emit([phone("USB1", "usb")]);
  await flush();
  await flush();

  source.setMainVideo(true);
  await flush();
  expect(sessions).toHaveLength(1);
  expect(sessions[0].startCalls).toBe(1);

  source.setMainVideo(true);
  await flush();
  expect(sessions).toHaveLength(1);

  source.setMainVideo(false);
  await flush();
  expect(sessions[0].stopped).toBe(true);
  expect(serials(phones)).toEqual(["USB1"]);

  sessions[0].end();
  await flush();
  expect(sessions).toHaveLength(1);
  expect(serials(phones)).toEqual(["USB1"]);
  await source.stop();
});

test("a phone leaving the device list is withdrawn", async () => {
  const { watcher, source, phones } = phoneListenerSource({ mainVideo: false });
  await source.start(fakeSink().sink);
  watcher.emit([phone("USB1", "usb")]);
  await flush();
  await flush();

  watcher.emit([]);
  await flush();
  expect(serials(phones)).toEqual(["USB1", null]);
  await source.stop();
  expect(serials(phones)).toEqual(["USB1", null]);
});

test("stop() withdraws the connected phone", async () => {
  const { watcher, source, phones } = phoneListenerSource();
  await source.start(fakeSink().sink);
  watcher.emit([phone("USB1", "usb")]);
  await flush();
  await flush();

  await source.stop();
  expect(serials(phones)).toEqual(["USB1", null]);
});

test("choosing another phone withdraws the first before announcing the second", async () => {
  const { watcher, source, phones } = phoneListenerSource();
  await source.start(fakeSink().sink);
  watcher.emit([phone("USB1", "usb"), phone("USB2", "usb")]);
  await flush();
  await flush();
  expect(serials(phones)).toEqual(["USB1"]);

  source.chooseDevice("USB2");
  await flush();
  expect(serials(phones)).toEqual(["USB1", null, "USB2"]);
  expect(phones[2]?.deviceId).toBe("OTHER");
  await source.stop();
});

test("with the main video on, the phone is announced once per connection and a video session that ends does not withdraw it", async () => {
  const { watcher, source, sessions, phones } = phoneListenerSource();
  await source.start(fakeSink().sink);
  watcher.emit([phone("USB1", "usb")]);
  await flush();
  await flush();
  expect(sessions).toHaveLength(1);
  expect(serials(phones)).toEqual(["USB1"]);

  sessions[0].streamed();
  sessions[0].end();
  await flush();
  expect(sessions).toHaveLength(2);
  expect(phones).not.toContain(null);
  await source.stop();
});
