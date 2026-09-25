import type { AdbHost } from "./adb-host";
import type { ControlIntent, MainToRenderer, RendererToMain } from "../shared/wire";
import { transferablesOf } from "../shared/wire";
import type { MediaSink, MediaSource } from "./media-source";
import { ScrcpySession } from "./scrcpy-session";
import type { StreamSettings } from "./scrcpy-init";
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
      void source.start(sink);
      return;
    }
    source.control(msg.intent);
  });

  return sink;
}

export class DeviceSource implements MediaSource {
  #sink: MediaSink | null = null;
  #dispose: (() => Promise<void>) | null = null;
  #session: MediaSource | null = null;
  #preferredSerial: string | null;
  #stopped = false;

  constructor(
    private readonly opts: {
      host: AdbHost;
      serverPath: string;
      settings: StreamSettings;
      preferredSerial?: string | null;
      log?: (line: string) => void;
    },
  ) {
    this.#preferredSerial = opts.preferredSerial ?? null;
  }

  async start(sink: MediaSink): Promise<void> {
    this.#sink = sink;
    this.#dispose = await this.opts.host.watch((devices) => this.#onDevices(devices));
  }

  control(intent: ControlIntent): void {
    this.#session?.control(intent);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#session?.stop();
    this.#session = null;
    await this.#dispose?.();
    this.#dispose = null;
  }

  #onDevices(devices: DeviceSummary[]): void {
    if (this.#stopped || !this.#sink) return;
    const device = pickDevice(devices, this.#preferredSerial);
    const status = deviceStatus(device);
    if (status) {
      if (this.#session) {
        const session = this.#session;
        this.#session = null;
        void session.stop();
      }
      this.#sink.status(status);
      return;
    }
    if (!device || this.#session) return;
    this.#preferredSerial = device.serial;
    void this.#connect(device);
  }

  async #connect(device: DeviceSummary): Promise<void> {
    const sink = this.#sink;
    if (!sink) return;
    const adb = await this.opts.host.open(device.serial);
    const session = new ScrcpySession({
      adb,
      serial: device.serial,
      model: device.model,
      serverPath: this.opts.serverPath,
      settings: this.opts.settings,
      log: this.opts.log,
    });
    this.#session = session;
    await session.start(sink);
  }
}
