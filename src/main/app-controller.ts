import { basename } from "node:path";
import type { Adb } from "@yume-chan/adb";
import type { ControlIntent, MainToRenderer, RendererToMain, SessionStatus, VideoStreamInfo } from "../shared/wire";
import { transferablesOf } from "../shared/wire";
import type { MediaSink, MediaSource } from "./media-source";
import { deviceStatus, pickDevice, type DeviceSummary } from "./transport";

export interface PortLike {
  postMessage(msg: MainToRenderer, transfer: ArrayBuffer[]): void;
  onMessage(fn: (msg: RendererToMain) => void): void;
}

function withLogHint(status: SessionStatus, hint: string): SessionStatus {
  if (!hint || status.state !== "error") return status;
  return { ...status, message: `${status.message} ${hint}` };
}

/**
 * Wires a MediaSource to a renderer port. A repeated "ready" (the renderer
 * reloaded, e.g. after Ctrl+R or a crash) must not restart the source, since
 * it is still running from the main process's point of view; instead replay
 * the last video-start and the latest configuration packet so the new
 * renderer context can pick the stream back up without a fresh server start.
 */
export function bindSource(source: MediaSource, port: PortLike, opts?: { logPath?: string }): MediaSink {
  const logHint = opts?.logPath ? `(log: ${basename(opts.logPath)})` : "";

  function post(msg: MainToRenderer): void {
    port.postMessage(msg, transferablesOf(msg));
  }

  let lastVideoStart: VideoStreamInfo | null = null;
  let lastConfigPacket: { type: "configuration"; data: Uint8Array } | null = null;

  const sink: MediaSink = {
    videoStart: (info) => {
      lastVideoStart = info;
      lastConfigPacket = null;
      post({ kind: "video-start", info });
    },
    videoPacket: (packet) => {
      if (packet.type === "configuration") lastConfigPacket = { type: "configuration", data: packet.data.slice() };
      post({ kind: "video-packet", packet });
    },
    videoEnd: () => post({ kind: "video-end" }),
    status: (status) => post({ kind: "status", status: withLogHint(status, logHint) }),
    posture: (reading) => post({ kind: "posture", reading }),
  };

  let started = false;
  port.onMessage((msg) => {
    if (msg.kind === "ready") {
      if (started) {
        if (lastVideoStart) post({ kind: "video-start", info: lastVideoStart });
        if (lastConfigPacket) post({ kind: "video-packet", packet: { type: "configuration", data: lastConfigPacket.data.slice() } });
        return;
      }
      started = true;
      source.start(sink).catch((e) => sink.status({ state: "error", message: String(e) }));
      return;
    }
    source.control(msg.intent);
  });

  return sink;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
const SESSION_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

export interface DeviceWatcher {
  ensureServer(): Promise<"existing" | "spawned">;
  watch(onChange: (devices: DeviceSummary[]) => void, onError?: (err: Error) => void): Promise<() => Promise<void>>;
  open(serial: string): Promise<Adb>;
}

export type SessionFactory = (device: DeviceSummary, adb: Adb) => MediaSource;

/** Same shape as fold-monitor.ts's startFoldMonitor, kept as its own type here so DeviceSource stays testable without a real adb. */
export type FoldMonitorStarter = (
  adb: Adb,
  sink: MediaSink,
  log: (line: string) => void,
) => Promise<() => Promise<void>>;

export class DeviceSource implements MediaSource {
  #sink: MediaSink | null = null;
  #dispose: (() => Promise<void>) | null = null;
  #session: MediaSource | null = null;
  #sessionSerial: string | null = null;
  #stopPosture: (() => Promise<void>) | null = null;
  #reconnecting = false;
  #reconnectAbort: AbortController | null = null;
  #lastDevices: DeviceSummary[] = [];
  #preferredSerial: string | null;
  #stopped = false;
  #sessionEverStreamed = false;
  #sessionRetryAttempt = 0;
  #sessionRetryAbort: AbortController | null = null;
  #lastSessionError: string | null = null;

  constructor(
    private readonly opts: {
      host: DeviceWatcher;
      createSession: SessionFactory;
      preferredSerial?: string | null;
      log?: (line: string) => void;
      delay?: (ms: number, signal: AbortSignal) => Promise<void>;
      /** Wraps the sink once at start(), e.g. to tee video and posture events into a recording. */
      recordSink?: (sink: MediaSink) => MediaSink;
      /** Started for every connected live session (not only while recording) and stopped with it. */
      foldMonitor?: FoldMonitorStarter;
    },
  ) {
    this.#preferredSerial = opts.preferredSerial ?? null;
  }

  async start(sink: MediaSink): Promise<void> {
    this.#sink = this.opts.recordSink ? this.opts.recordSink(sink) : sink;
    const watched = await this.#watch();
    if (!watched) this.#beginReconnect();
  }

  control(intent: ControlIntent): void {
    this.#session?.control(intent);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#reconnectAbort?.abort();
    this.#reconnectAbort = null;
    this.#sessionRetryAbort?.abort();
    this.#sessionRetryAbort = null;
    const session = this.#session;
    this.#session = null;
    this.#sessionSerial = null;
    await this.#stopPostureSampler();
    await session?.stop();
    await this.#dispose?.().catch(() => {});
    this.#dispose = null;
  }

  /** Installs a fresh device-tracking subscription. Returns whether it succeeded. */
  async #watch(): Promise<boolean> {
    let dispose: (() => Promise<void>) | undefined;
    try {
      dispose = await this.opts.host.watch(
        (devices) => this.#onWatcherDevices(devices),
        () => this.#onWatchError(),
      );
    } catch (e) {
      if (!this.#stopped) this.opts.log?.(`watch failed: ${String(e)}`);
      return false;
    }
    if (this.#stopped) {
      await dispose().catch(() => {});
      return true;
    }
    this.#dispose = dispose;
    return true;
  }

  #onWatchError(): void {
    if (this.#stopped || this.#reconnecting) return;
    const dispose = this.#dispose;
    this.#dispose = null;
    void dispose?.().catch(() => {});
    this.#beginReconnect();
  }

  #beginReconnect(): void {
    if (this.#stopped || this.#reconnecting) return;
    this.#reconnecting = true;
    this.opts.log?.("adb device tracking failed, reconnecting");
    this.#sink?.status({ state: "error", message: "Lost connection to the adb server, reconnecting..." });
    this.#reconnectAbort = new AbortController();
    void this.#reconnect(this.#reconnectAbort.signal);
  }

  async #reconnect(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    const delay = this.opts.delay ?? defaultDelay;
    while (!this.#stopped) {
      await delay(RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)], signal);
      if (this.#stopped) return;
      try {
        await this.opts.host.ensureServer();
        if (this.#stopped) return;
        const watched = await this.#watch();
        if (this.#stopped) return;
        if (watched) {
          this.#reconnecting = false;
          this.#reconnectAbort = null;
          return;
        }
        attempt++;
      } catch (e) {
        this.opts.log?.(`reconnect attempt failed: ${String(e)}`);
        attempt++;
      }
    }
  }

  /** The watcher's own onChange callback: a real device-list change always cancels and resets a pending session-start retry. */
  #onWatcherDevices(devices: DeviceSummary[]): void {
    this.#cancelSessionRetry();
    this.#onDevices(devices);
  }

  #onDevices(devices: DeviceSummary[]): void {
    this.#lastDevices = devices;
    if (this.#stopped || !this.#sink) return;
    const device = pickDevice(devices, this.#preferredSerial);
    const status = deviceStatus(device);
    if (status) {
      this.#teardownSession();
      this.#sink.status(status);
      return;
    }
    if (!device) return;
    if (this.#sessionSerial === device.serial) return;
    this.#teardownSession();
    this.#preferredSerial = device.serial;
    this.#connect(device);
  }

  #teardownSession(): void {
    const session = this.#session;
    this.#session = null;
    this.#sessionSerial = null;
    void this.#stopPostureSampler();
    if (session) void session.stop();
  }

  async #stopPostureSampler(): Promise<void> {
    const stop = this.#stopPosture;
    this.#stopPosture = null;
    await stop?.().catch(() => {});
  }

  #connect(device: DeviceSummary): void {
    this.#sessionSerial = device.serial;
    this.#sessionEverStreamed = false;
    void this.#run(device);
  }

  async #run(device: DeviceSummary): Promise<void> {
    const sink = this.#sink;
    if (!sink) return;
    const observedSink: MediaSink = {
      ...sink,
      status: (status) => {
        if (status.state === "streaming") {
          this.#sessionEverStreamed = true;
          this.#sessionRetryAttempt = 0;
        }
        if (status.state === "error") this.#lastSessionError = status.message;
        sink.status(status);
      },
    };
    try {
      const adb = await this.opts.host.open(device.serial);
      if (this.#stopped || this.#sessionSerial !== device.serial) return;
      if (this.opts.foldMonitor) {
        try {
          this.#stopPosture = await this.opts.foldMonitor(adb, sink, this.opts.log ?? (() => {}));
        } catch (e) {
          this.opts.log?.(`fold monitor failed to start: ${String(e)}`);
        }
        if (this.#stopped || this.#sessionSerial !== device.serial) {
          await this.#stopPostureSampler();
          return;
        }
      }
      const session = this.opts.createSession(device, adb);
      this.#session = session;
      session.ended?.then(() => this.#onSessionEnded(session));
      await session.start(observedSink);
    } catch (e) {
      await this.#stopPostureSampler();
      if (this.#stopped || this.#sessionSerial !== device.serial) return;
      this.#session = null;
      this.#sessionSerial = null;
      this.opts.log?.(`session start failed: ${String(e)}`);
      this.#lastSessionError = String(e);
      this.#beginSessionRetry();
    }
  }

  /**
   * Matched against the session object, not the device serial: a session
   * that was already superseded by a newer one on the identical serial (a
   * reconnect) must not have its own late "ended" detach the newer session.
   */
  #onSessionEnded(session: MediaSource): void {
    if (this.#stopped || this.#session !== session) return;
    const streamed = this.#sessionEverStreamed;
    this.#session = null;
    this.#sessionSerial = null;
    void this.#stopPostureSampler();
    if (streamed) {
      this.#sessionRetryAttempt = 0;
      this.#onDevices(this.#lastDevices);
      return;
    }
    this.#beginSessionRetry();
  }

  /**
   * A session that never reached "streaming" before ending is a persistent
   * start failure (bad jar, no encoder, etc), not a transient disconnect:
   * reconnecting immediately would hot-loop at adb speed. Keep the last
   * error on screen with a countdown and back off instead.
   */
  #beginSessionRetry(): void {
    if (this.#stopped) return;
    const delayMs = SESSION_RETRY_DELAYS_MS[Math.min(this.#sessionRetryAttempt, SESSION_RETRY_DELAYS_MS.length - 1)];
    const base = this.#lastSessionError ?? "Failed to start";
    this.#sink?.status({ state: "error", message: `${base} (retrying in ${Math.round(delayMs / 1000)}s)` });
    const controller = new AbortController();
    this.#sessionRetryAbort = controller;
    const delay = this.opts.delay ?? defaultDelay;
    void delay(delayMs, controller.signal).then(() => {
      // Superseded (a newer retry started) or cancelled (device-list change or stop): the
      // cancelling code path already decided what happens next, do nothing here.
      if (this.#stopped || this.#sessionRetryAbort !== controller) return;
      this.#sessionRetryAbort = null;
      this.#sessionRetryAttempt++;
      this.#onDevices(this.#lastDevices);
    });
  }

  #cancelSessionRetry(): void {
    this.#sessionRetryAbort?.abort();
    this.#sessionRetryAbort = null;
    this.#sessionRetryAttempt = 0;
  }
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
