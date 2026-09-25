import { expect, test } from "vitest";
import { bindSource, DeviceSource, type DeviceWatcher, type FoldMonitorStarter, type PortLike } from "../../src/main/app-controller";
import type { MediaSource, MediaSink } from "../../src/main/media-source";
import type { ControlIntent, MainToRenderer, RendererToMain, SessionStatus } from "../../src/shared/wire";
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
  return { serial, state: "device", model: null, transport };
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
    this.#sink?.status({ state: "streaming", serial: "unused", model: null });
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
