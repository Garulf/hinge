import { expect, test } from "vitest";
import { bindSource, DeviceSource, type DeviceWatcher, type PortLike } from "../../src/main/app-controller";
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
  #resolveEnded!: () => void;
  readonly ended: Promise<void> = new Promise((resolve) => {
    this.#resolveEnded = resolve;
  });

  async start(): Promise<void> {
    this.startCalls++;
  }

  control(): void {}

  async stop(): Promise<void> {
    this.stopped = true;
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

  sessions[0].end();
  await flush();
  expect(opened).toEqual(["USB1", "USB1"]);
  expect(sessions).toHaveLength(2);
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
