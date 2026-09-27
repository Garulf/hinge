import { basename } from "node:path";
import type { Adb } from "@yume-chan/adb";
import type { PostureReading } from "../shared/posture";
import type { AudioStreamInfo, ControlIntent, DeviceCommand, DeviceCommandResult, MainToRenderer, RendererToMain, SessionStatus, VideoStreamInfo } from "../shared/wire";
import { transferablesOf } from "../shared/wire";
import type { MediaSink, MediaSource } from "./media-source";
import { dedupeDevices, deviceIdentity, deviceStatus, pickDevice, transportOf, type DeviceSummary } from "./transport";
import { connectOrAlreadyConnected, pairNewDevice, switchDeviceToWifi, type WirelessDeps } from "./wireless";

export interface PortLike {
  postMessage(msg: MainToRenderer, transfer: ArrayBuffer[]): void;
  onMessage(fn: (msg: RendererToMain) => void): void;
}

function withLogHint(status: SessionStatus, hint: string): SessionStatus {
  if (!hint || status.state !== "error") return status;
  return { ...status, message: `${status.message} ${hint}` };
}

/** A device command that rejects outright (rather than resolving with its own ok:false) still needs a same-shaped result to send back. */
function errorResult(type: DeviceCommand["type"], message: string): DeviceCommandResult {
  switch (type) {
    case "list":
      return { type, devices: [] };
    case "pair":
      return { type, ok: false, connectedAddress: null, message };
    case "switch-to-wifi":
      return { type, ok: false, address: null, message };
    case "connect":
    case "disconnect":
      return { type, ok: false, message };
  }
}

/**
 * Wires a MediaSource to a renderer port. A repeated "ready" (the renderer
 * reloaded, e.g. after Ctrl+R or a crash) must not restart the source, since
 * it is still running from the main process's point of view; instead replay
 * the last video-start and the latest configuration packet so the new
 * renderer context can pick the stream back up without a fresh server start,
 * followed by the last posture reading so the fold pose comes back too, and
 * the live audio stream's start and configuration packet.
 */
export function bindSource(source: MediaSource, port: PortLike, opts?: { logPath?: string; onStatus?: (status: SessionStatus) => void }): MediaSink {
  const logHint = opts?.logPath ? `(log: ${basename(opts.logPath)})` : "";

  function post(msg: MainToRenderer): void {
    port.postMessage(msg, transferablesOf(msg));
  }

  let lastVideoStart: VideoStreamInfo | null = null;
  let lastConfigPacket: { type: "configuration"; data: Uint8Array } | null = null;
  let lastPosture: PostureReading | null = null;
  let lastAudioStart: AudioStreamInfo | null = null;
  let lastAudioConfigPacket: { type: "configuration"; data: Uint8Array } | null = null;

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
    status: (status) => {
      opts?.onStatus?.(status);
      post({ kind: "status", status: withLogHint(status, logHint) });
    },
    posture: (reading) => {
      lastPosture = reading;
      post({ kind: "posture", reading });
    },
    audioStart: (info) => {
      lastAudioStart = info;
      lastAudioConfigPacket = null;
      post({ kind: "audio-start", info });
    },
    audioPacket: (packet) => {
      if (packet.type === "configuration") lastAudioConfigPacket = { type: "configuration", data: packet.data.slice() };
      post({ kind: "audio-packet", packet });
    },
    audioEnd: (reason) => {
      lastAudioStart = null;
      lastAudioConfigPacket = null;
      post({ kind: "audio-end", reason });
    },
    transferProgress: (progress) => post({ kind: "transfer-progress", progress }),
    devices: (devices) => post({ kind: "devices", devices }),
  };

  let started = false;
  port.onMessage((msg) => {
    if (msg.kind === "ready") {
      if (started) {
        if (lastVideoStart) post({ kind: "video-start", info: lastVideoStart });
        if (lastConfigPacket) post({ kind: "video-packet", packet: { type: "configuration", data: lastConfigPacket.data.slice() } });
        if (lastPosture) post({ kind: "posture", reading: lastPosture });
        if (lastAudioStart) post({ kind: "audio-start", info: lastAudioStart });
        if (lastAudioConfigPacket) post({ kind: "audio-packet", packet: { type: "configuration", data: lastAudioConfigPacket.data.slice() } });
        return;
      }
      started = true;
      source.start(sink).catch((e) => sink.status({ state: "error", message: String(e) }));
      return;
    }
    if (msg.kind === "drop-files") {
      source.transfer?.(msg.paths);
      return;
    }
    if (msg.kind === "device-command") {
      if (!source.handleDeviceCommand) {
        post({ kind: "device-command-result", id: msg.id, result: errorResult(msg.command.type, "no phone connection in this mode") });
        return;
      }
      source
        .handleDeviceCommand(msg.command)
        .then((result) => post({ kind: "device-command-result", id: msg.id, result }))
        .catch((e) => post({ kind: "device-command-result", id: msg.id, result: errorResult(msg.command.type, String(e)) }));
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
  /** The phone's `getprop ro.serialno` over this transport, null when it could not be read. Absent: identities come from the serial alone. */
  identify?(serial: string): Promise<string | null>;
}

/** `deviceId` is the phone's identity, which per-phone settings are keyed by. */
export type SessionFactory = (device: DeviceSummary, adb: Adb, deviceId: string) => MediaSource;

/** Same shape as fold-monitor.ts's startFoldMonitor, kept as its own type here so DeviceSource stays testable without a real adb. */
export type FoldMonitorStarter = (
  adb: Adb,
  sink: MediaSink,
  log: (line: string) => void,
) => Promise<() => Promise<void>>;

/** Same shape as notification-mirror.ts's startNotificationMirror, already bound to its own settings/notifier/window deps by the caller. */
export type NotificationMirrorStarter = (
  adb: Adb,
  log: (line: string) => void,
) => Promise<() => Promise<void>>;

export class DeviceSource implements MediaSource {
  #sink: MediaSink | null = null;
  #dispose: (() => Promise<void>) | null = null;
  #session: MediaSource | null = null;
  #sessionSerial: string | null = null;
  #stopPosture: (() => Promise<void>) | null = null;
  #stopNotifications: (() => Promise<void>) | null = null;
  #reconnecting = false;
  #reconnectAbort: AbortController | null = null;
  #lastDevices: DeviceSummary[] = [];
  /** An adb serial (an explicit choice, until it connects) or a phone identity (the phone last connected). */
  #preferred: string | null;
  #identities = new Map<string, string>();
  #identifying = new Set<string>();
  #stopped = false;
  #sessionEverStreamed = false;
  #sessionRetryAttempt = 0;
  #sessionRetryAbort: AbortController | null = null;
  #lastSessionError: string | null = null;
  #runToken = 0;
  #tcpReconnectAbort: AbortController | null = null;
  /** The identity of a phone the user disconnected; every transport of it is excluded from auto-pick and TCP reconnect until chooseDevice() clears it. */
  #suppressedId: string | null = null;
  /** The last transport that actually reached "streaming" this run; TCP reconnect only arms for it, not for a stale lastDevice that has never once connected. */
  #reconnectEligible: { serial: string; id: string } | null = null;

  constructor(
    private readonly opts: {
      host: DeviceWatcher;
      createSession: SessionFactory;
      /** An adb serial or a phone identity to prefer over the USB-first default. */
      preferred?: string | null;
      log?: (line: string) => void;
      delay?: (ms: number, signal: AbortSignal) => Promise<void>;
      /** Wraps the sink once at start(), e.g. to tee video and posture events into a recording. */
      recordSink?: (sink: MediaSink) => MediaSink;
      /** Started for every connected live session (not only while recording) and stopped with it. */
      foldMonitor?: FoldMonitorStarter;
      /** Started for every connected live session, alongside foldMonitor; the closure itself decides whether mirroring is on. */
      notificationMirror?: NotificationMirrorStarter;
      /** Absent in contexts with no adb server access (e.g. replay): TCP reconnect and device-panel commands are then both unavailable. */
      wireless?: WirelessDeps;
      /** Fired with the phone's identity whenever a device is chosen to connect to (automatic pick or chooseDevice()), so the caller can remember it as the last device. */
      onConnected?: (id: string) => void;
      /** Fired the first time a transport's identity is known; connecting waits for it, so settings saved under the old serial can move over first. */
      onIdentified?: (serial: string, id: string) => Promise<void> | void;
    },
  ) {
    this.#preferred = opts.preferred ?? null;
  }

  async start(sink: MediaSink): Promise<void> {
    this.#sink = this.opts.recordSink ? this.opts.recordSink(sink) : sink;
    const watched = await this.#watch();
    if (!watched) this.#beginReconnect();
  }

  control(intent: ControlIntent): void {
    this.#session?.control(intent);
  }

  transfer(localPaths: string[]): void {
    this.#session?.transfer?.(localPaths);
  }

  /** Manual device choice (e.g. from a device panel): pins the serial and switches the session to it immediately if it is already listed. */
  chooseDevice(serial: string): void {
    if (this.#stopped) return;
    this.#cancelTcpReconnect();
    this.#suppressedId = null;
    this.#preferred = serial;
    const device = this.#lastDevices.find((d) => d.serial === serial);
    if (!device) return;
    if (this.#identityOf(device) === null) {
      this.#identify(device);
      return;
    }
    const status = deviceStatus(device);
    if (status) {
      this.#teardownSession();
      this.#sink?.status(status);
      return;
    }
    if (this.#sessionSerial === device.serial) return;
    this.#teardownSession();
    this.#connect(device);
  }

  async handleDeviceCommand(command: DeviceCommand): Promise<DeviceCommandResult> {
    switch (command.type) {
      case "list":
        return { type: "list", devices: this.#deviceList() };
      case "pair": {
        if (!this.opts.wireless) return { type: "pair", ok: false, connectedAddress: null, message: "wireless is unavailable" };
        try {
          const result = await pairNewDevice(this.opts.wireless, command.hostPort, command.code);
          if (result.connectedAddress) this.chooseDevice(result.connectedAddress);
          return { type: "pair", ok: true, connectedAddress: result.connectedAddress, message: result.message };
        } catch (e) {
          return { type: "pair", ok: false, connectedAddress: null, message: String(e) };
        }
      }
      case "connect": {
        if (!this.opts.wireless) return { type: "connect", ok: false, message: "wireless is unavailable" };
        // Not already listed: this is the "ask for the connect port" fallback
        // after a pair() that couldn't find the mDNS service on its own, so
        // adb needs an explicit connect before the serial will ever appear.
        if (!this.#lastDevices.some((d) => d.serial === command.serial)) {
          try {
            await connectOrAlreadyConnected(this.opts.wireless, command.serial);
          } catch (e) {
            return { type: "connect", ok: false, message: String(e) };
          }
        }
        this.chooseDevice(command.serial);
        return { type: "connect", ok: true };
      }
      case "switch-to-wifi": {
        if (!this.opts.wireless) return { type: "switch-to-wifi", ok: false, address: null, message: "wireless is unavailable" };
        if (transportOf(command.serial) !== "usb") {
          return { type: "switch-to-wifi", ok: false, address: null, message: "only a USB-connected device can switch to Wi-Fi" };
        }
        const adb = await this.opts.host.open(command.serial);
        try {
          const address = await switchDeviceToWifi(this.opts.wireless, adb);
          this.chooseDevice(address);
          return { type: "switch-to-wifi", ok: true, address };
        } catch (e) {
          return { type: "switch-to-wifi", ok: false, address: null, message: String(e) };
        } finally {
          await adb.close().catch(() => {});
        }
      }
      case "disconnect": {
        if (!this.opts.wireless) return { type: "disconnect", ok: false, message: "wireless is unavailable" };
        if (transportOf(command.serial) === "usb") return { type: "disconnect", ok: false, message: "cannot disconnect a USB-connected device this way" };
        // Suppress the phone before the async disconnect resolves: otherwise
        // a device-list update racing the disconnect can arm a reconnect, or
        // pick its other transport, just after the user asked to end it.
        this.#cancelTcpReconnect();
        const listed = this.#lastDevices.find((d) => d.serial === command.serial);
        const id = listed ? this.#settledIdentity(listed) : command.serial;
        this.#suppressedId = id;
        if (this.#preferred === id || this.#preferred === command.serial) this.#preferred = null;
        this.#onDevices(this.#lastDevices);
        try {
          for (const address of this.#disconnectTargets(command.serial, id)) await this.opts.wireless.disconnect(address);
          return { type: "disconnect", ok: true };
        } catch (e) {
          return { type: "disconnect", ok: false, message: String(e) };
        }
      }
    }
  }

  /** adb can only drop a wireless transport by its ip:port; an mDNS-only phone gets its mDNS serial as a best effort. */
  #disconnectTargets(serial: string, id: string): string[] {
    const tcp = this.#lastDevices.filter((d) => d.transport === "tcp" && (d.serial === serial || this.#identityOf(d) === id)).map((d) => d.serial);
    return tcp.length > 0 ? tcp : [serial];
  }

  #deviceList(): DeviceSummary[] {
    return dedupeDevices(this.#lastDevices, this.#sessionSerial, (d) => this.#identityOf(d));
  }

  /** null while a ready transport's ro.serialno is still being read; one that cannot run a shell (unauthorized, offline) goes by its serial. */
  #identityOf(device: DeviceSummary): string | null {
    const known = this.#identities.get(device.serial);
    if (known !== undefined) return known;
    if (this.opts.host.identify && device.state === "device") return null;
    return deviceIdentity(device, null);
  }

  #settledIdentity(device: DeviceSummary): string {
    return this.#identityOf(device) ?? deviceIdentity(device, null);
  }

  #identify(device: DeviceSummary): void {
    const identify = this.opts.host.identify;
    if (!identify || this.#identifying.has(device.serial)) return;
    this.#identifying.add(device.serial);
    void (async () => {
      let serialno: string | null = null;
      try {
        serialno = await identify.call(this.opts.host, device.serial);
      } catch (e) {
        this.opts.log?.(`reading ro.serialno over ${device.serial} failed: ${String(e)}`);
      }
      const id = deviceIdentity(device, serialno);
      try {
        await this.opts.onIdentified?.(device.serial, id);
      } catch (e) {
        this.opts.log?.(`adopting settings for ${device.serial} failed: ${String(e)}`);
      }
      this.#identifying.delete(device.serial);
      if (this.#stopped) return;
      this.#identities.set(device.serial, id);
      this.#onDevices(this.#lastDevices);
    })();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelTcpReconnect();
    this.#reconnectAbort?.abort();
    this.#reconnectAbort = null;
    this.#sessionRetryAbort?.abort();
    this.#sessionRetryAbort = null;
    const session = this.#session;
    this.#session = null;
    this.#sessionSerial = null;
    await this.#stopPostureSampler();
    await this.#stopNotificationMirrorSampler();
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
    const listed = new Set(devices.map((d) => d.serial));
    for (const serial of this.#identities.keys()) if (!listed.has(serial)) this.#identities.delete(serial);
    this.#onDevices(devices);
  }

  #onDevices(devices: DeviceSummary[]): void {
    this.#lastDevices = devices;
    if (this.#stopped || !this.#sink) return;
    const unidentified = devices.filter((d) => this.#identityOf(d) === null);
    if (unidentified.length > 0) {
      for (const d of unidentified) this.#identify(d);
      return;
    }
    this.#sink.devices?.(this.#deviceList());
    // An explicitly disconnected phone must not be auto-picked back up by
    // a race between the device list updating and the disconnect resolving.
    const suppressed = this.#suppressedId;
    const candidates = suppressed ? devices.filter((d) => d.serial !== suppressed && this.#identityOf(d) !== suppressed) : devices;
    const device = pickDevice(candidates, this.#preferred, (d) => this.#identityOf(d), this.#sessionSerial);
    const status = deviceStatus(device);
    if (status) {
      this.#teardownSession();
      this.#sink.status(status);
      if (status.state === "no-device") this.#maybeBeginTcpReconnect();
      return;
    }
    this.#cancelTcpReconnect();
    if (!device) return;
    if (this.#sessionSerial === device.serial) return;
    this.#teardownSession();
    this.#connect(device);
  }

  /**
   * A USB device dropping just means "unplugged"; adb's own tracking picks
   * it back up when replugged. A TCP/mDNS device dropping means the phone
   * left adb's connected-device list entirely (Wi-Fi hiccup, phone asleep):
   * nothing will bring it back without an explicit `wireless.connect`,
   * which this retries on a backoff until it succeeds or the device list
   * changes again (a real change, a manual chooseDevice(), or stop()).
   */
  #maybeBeginTcpReconnect(): void {
    if (this.#stopped || this.#tcpReconnectAbort || !this.opts.wireless) return;
    const target = this.#reconnectEligible;
    if (!target || transportOf(target.serial) === "usb") return;
    if (this.#preferred !== target.id && this.#preferred !== target.serial) return;
    if (this.#suppressedId === target.id) return;
    const controller = new AbortController();
    this.#tcpReconnectAbort = controller;
    void this.#tcpReconnectLoop(target.serial, controller);
  }

  async #tcpReconnectLoop(address: string, controller: AbortController): Promise<void> {
    const delay = this.opts.delay ?? defaultDelay;
    let attempt = 0;
    while (!this.#stopped && !controller.signal.aborted) {
      await delay(SESSION_RETRY_DELAYS_MS[Math.min(attempt, SESSION_RETRY_DELAYS_MS.length - 1)], controller.signal);
      if (this.#stopped || controller.signal.aborted) break;
      try {
        await connectOrAlreadyConnected(this.opts.wireless!, address);
        break; // adb's own device tracking picks the reconnected device up from here
      } catch (e) {
        this.opts.log?.(`wireless reconnect attempt failed: ${String(e)}`);
        attempt++;
      }
    }
    if (this.#tcpReconnectAbort === controller) this.#tcpReconnectAbort = null;
  }

  #cancelTcpReconnect(): void {
    this.#tcpReconnectAbort?.abort();
    this.#tcpReconnectAbort = null;
  }

  #teardownSession(): void {
    this.#runToken++;
    const session = this.#session;
    this.#session = null;
    this.#sessionSerial = null;
    void this.#stopPostureSampler();
    void this.#stopNotificationMirrorSampler();
    if (session) void session.stop();
  }

  async #stopPostureSampler(): Promise<void> {
    const stop = this.#stopPosture;
    this.#stopPosture = null;
    await stop?.().catch(() => {});
  }

  async #stopNotificationMirrorSampler(): Promise<void> {
    const stop = this.#stopNotifications;
    this.#stopNotifications = null;
    await stop?.().catch(() => {});
  }

  #connect(device: DeviceSummary): void {
    const id = this.#settledIdentity(device);
    this.#sessionSerial = device.serial;
    this.#sessionEverStreamed = false;
    this.#preferred = id;
    this.opts.onConnected?.(id);
    const run = ++this.#runToken;
    void this.#run(device, id, run);
  }

  /**
   * `run` is a token captured once, at the moment this call started: every
   * check below compares against the CURRENT #runToken rather than the
   * device serial, so a run superseded by a same-serial reconnect (the
   * device drops and reappears while this run is still awaiting adb) is
   * recognised as stale even though the serial is unchanged. The fold
   * monitor is started without being awaited, so a slow print-states/sampler
   * round trip never delays createSession()/session.start(); its stop
   * function is held locally and only published to #stopPosture once this
   * run is confirmed still current, otherwise it is stopped immediately
   * instead of being discarded (which would leak it).
   */
  async #run(device: DeviceSummary, id: string, run: number): Promise<void> {
    const sink = this.#sink;
    if (!sink) return;
    const observedSink: MediaSink = {
      ...sink,
      status: (status) => {
        if (status.state === "streaming") {
          this.#sessionEverStreamed = true;
          this.#sessionRetryAttempt = 0;
          this.#reconnectEligible = { serial: device.serial, id };
        }
        if (status.state === "error") this.#lastSessionError = status.message;
        sink.status(status);
      },
    };
    try {
      const adb = await this.opts.host.open(device.serial);
      if (this.#stopped || this.#runToken !== run) return;

      if (this.opts.foldMonitor) void this.#startFoldMonitor(run, adb, sink);
      if (this.opts.notificationMirror) void this.#startNotificationMirror(run, adb);

      const session = this.opts.createSession(device, adb, id);
      this.#session = session;
      session.ended?.then(() => this.#onSessionEnded(session));
      await session.start(observedSink);
    } catch (e) {
      if (this.#stopped || this.#runToken !== run) return;
      this.#runToken++;
      this.#session = null;
      this.#sessionSerial = null;
      this.opts.log?.(`session start failed: ${String(e)}`);
      this.#lastSessionError = String(e);
      this.#beginSessionRetry();
    }
  }

  async #startFoldMonitor(run: number, adb: Adb, sink: MediaSink): Promise<void> {
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = await this.opts.foldMonitor!(adb, sink, this.opts.log ?? (() => {}));
    } catch (e) {
      this.opts.log?.(`fold monitor failed to start: ${String(e)}`);
      return;
    }
    if (this.#stopped || this.#runToken !== run) {
      await stop().catch(() => {});
      return;
    }
    this.#stopPosture = stop;
  }

  /** Same shape as #startFoldMonitor: started without being awaited, its stop function only published once this run is still current. */
  async #startNotificationMirror(run: number, adb: Adb): Promise<void> {
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = await this.opts.notificationMirror!(adb, this.opts.log ?? (() => {}));
    } catch (e) {
      this.opts.log?.(`notification mirror failed to start: ${String(e)}`);
      return;
    }
    if (this.#stopped || this.#runToken !== run) {
      await stop().catch(() => {});
      return;
    }
    this.#stopNotifications = stop;
  }

  /**
   * Matched against the session object, not the device serial: a session
   * that was already superseded by a newer one on the identical serial (a
   * reconnect) must not have its own late "ended" detach the newer session.
   */
  #onSessionEnded(session: MediaSource): void {
    if (this.#stopped || this.#session !== session) return;
    this.#runToken++;
    const streamed = this.#sessionEverStreamed;
    this.#session = null;
    this.#sessionSerial = null;
    void this.#stopPostureSampler();
    void this.#stopNotificationMirrorSampler();
    void session.stop();
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
