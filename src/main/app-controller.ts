import type { Adb } from "@yume-chan/adb";
import type { ControlIntent, MainToRenderer, RendererToMain } from "../shared/wire";
import { transferablesOf } from "../shared/wire";
import type { MediaSink, MediaSource } from "./media-source";
import type { PostureSample } from "./posture-sampler";
import { deviceStatus, pickDevice, type DeviceSummary } from "./transport";

export interface PortLike {
  postMessage(msg: MainToRenderer, transfer: ArrayBuffer[]): void;
  onMessage(fn: (msg: RendererToMain) => void): void;
}

export function bindSource(source: MediaSource, port: PortLike): MediaSink {
  function post(msg: MainToRenderer): void {
    port.postMessage(msg, transferablesOf(msg));
  }

  const sink: MediaSink = {
    videoStart: (info) => post({ kind: "video-start", info }),
    videoPacket: (packet) => post({ kind: "video-packet", packet }),
    videoEnd: () => post({ kind: "video-end" }),
    status: (status) => post({ kind: "status", status }),
  };

  let started = false;
  port.onMessage((msg) => {
    if (msg.kind === "ready") {
      if (started) return;
      started = true;
      source.start(sink).catch((e) => sink.status({ state: "error", message: String(e) }));
      return;
    }
    source.control(msg.intent);
  });

  return sink;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];

export interface DeviceWatcher {
  ensureServer(): Promise<"existing" | "spawned">;
  watch(onChange: (devices: DeviceSummary[]) => void, onError?: (err: Error) => void): Promise<() => Promise<void>>;
  open(serial: string): Promise<Adb>;
}

export type SessionFactory = (device: DeviceSummary, adb: Adb) => MediaSource;

/**
 * Starts a background posture sampler bound to one session's adb connection.
 * Returns a disposer that stops it. Mirrors posture-sampler.ts's startSampler,
 * kept as a separate type here so DeviceSource stays testable without a real adb.
 */
export type PostureStarter = (
  adb: Adb,
  onSample: (sample: PostureSample) => void,
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

  constructor(
    private readonly opts: {
      host: DeviceWatcher;
      createSession: SessionFactory;
      preferredSerial?: string | null;
      log?: (line: string) => void;
      delay?: (ms: number, signal: AbortSignal) => Promise<void>;
      /** Wraps the sink once at start(), e.g. to tee video and posture events into a recording. */
      recordSink?: (sink: MediaSink) => MediaSink;
      /** Started for each connected session, only when the (possibly wrapped) sink defines postureLine. */
      posture?: PostureStarter;
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
        (devices) => this.#onDevices(devices),
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
    void this.#run(device);
  }

  async #run(device: DeviceSummary): Promise<void> {
    const sink = this.#sink;
    if (!sink) return;
    try {
      const adb = await this.opts.host.open(device.serial);
      if (this.#stopped || this.#sessionSerial !== device.serial) return;
      if (sink.postureLine && this.opts.posture) {
        this.#stopPosture = await this.opts.posture(adb, (sample) => sink.postureLine?.(sample.lines.join(" | ")));
        if (this.#stopped || this.#sessionSerial !== device.serial) {
          await this.#stopPostureSampler();
          return;
        }
      }
      const session = this.opts.createSession(device, adb);
      this.#session = session;
      session.ended?.then(() => this.#onSessionEnded(device.serial));
      await session.start(sink);
    } catch (e) {
      if (this.#sessionSerial === device.serial) {
        this.#session = null;
        this.#sessionSerial = null;
      }
      await this.#stopPostureSampler();
      sink.status({ state: "error", message: String(e) });
    }
  }

  #onSessionEnded(serial: string): void {
    if (this.#stopped || this.#sessionSerial !== serial) return;
    this.#session = null;
    this.#sessionSerial = null;
    void this.#stopPostureSampler();
    this.#onDevices(this.#lastDevices);
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
