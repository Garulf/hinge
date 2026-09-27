import { readFile } from "node:fs/promises";
import { PackageManager } from "@yume-chan/android-bin";
import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptions4_1 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, type ScrcpyVideoStreamPacket } from "@yume-chan/scrcpy";
import { PushReadableStream } from "@yume-chan/stream-extra";
import { createClipboardSync, type ClipboardHost, type ClipboardSync } from "./clipboard-sync";
import { applyIntent, type ApplyIntentDeps } from "./intents";
import type { MediaSink, MediaSource } from "./media-source";
import { buildInit, type SessionRole, type StreamSettings } from "./scrcpy-init";
import { createTransferQueue, defaultOpenFile, type TransferDeps, type TransferQueue } from "./transfers";
import type { DisplayGeometry } from "../shared/popout";
import { toWire, toWireAudio, type ControlIntent } from "../shared/wire";

/**
 * Bridges a plain (DOM-shaped) ReadableStream<Uint8Array> from transfers.ts
 * into the PushReadableStream Tango's own sync/install calls expect;
 * backpressure and cancellation both flow through in either direction.
 */
function toPushReadable(source: ReadableStream<Uint8Array>): PushReadableStream<Uint8Array> {
  return new PushReadableStream<Uint8Array>(async (controller) => {
    const reader = source.getReader();
    try {
      for (;;) {
        if (controller.abortSignal.aborted) {
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const ok = await controller.enqueue(value);
        if (!ok) {
          await reader.cancel();
          return;
        }
      }
      controller.close();
    } catch (e) {
      controller.error(e);
    }
  });
}

type Client = AdbScrcpyClient<AdbScrcpyOptions4_1<any>>;

const FIRST_PACKET_TIMEOUT_MS = 10_000;

/**
 * The real Tango calls, isolated behind an interface so a fake server (no
 * jar, no adb, no device) can drive the attempt loop, the per-attempt jar
 * push and the first-packet timeout in tests.
 */
export interface ScrcpyServerDeps {
  readServerJar(path: string): Promise<Uint8Array>;
  pushServer(adb: Adb, jar: Uint8Array): Promise<void>;
  startClient(adb: Adb, options: AdbScrcpyOptions4_1<any>): Promise<Client>;
}

const defaultDeps: ScrcpyServerDeps = {
  readServerJar: (path) => readFile(path),
  pushServer: async (adb, jar) => {
    await AdbScrcpyClient.pushServer(
      adb,
      new PushReadableStream<Uint8Array>((controller) => {
        controller.enqueue(jar);
        controller.close();
      }),
    );
  },
  startClient: (adb, options) => AdbScrcpyClient.start(adb, DefaultServerPath, options),
};

export class ScrcpySession implements MediaSource {
  #client: Client | undefined;
  #stopped = false;
  #videoEnded = false;
  #endedFired = false;
  #resolveEnded!: () => void;
  readonly ended: Promise<void>;
  readonly #deps: ScrcpyServerDeps;
  readonly #firstPacketTimeoutMs: number;
  readonly #clipboardHost: ClipboardHost | undefined;
  #clipboardSync: ClipboardSync | null = null;
  readonly #transfers: TransferQueue;
  #sink: MediaSink | null = null;

  constructor(
    private readonly opts: {
      adb: Adb;
      serial: string;
      model: string | null;
      /** The phone's identity for the streaming status; the serial when not given. */
      deviceId?: string;
      serverPath: string;
      settings: StreamSettings;
      log?: (line: string) => void;
      deps?: Partial<ScrcpyServerDeps>;
      firstPacketTimeoutMs?: number;
      /** Absent in contexts with no PC clipboard access (e.g. the probe mode): clipboard sync and clipboard-paste are then both no-ops. */
      clipboardHost?: ClipboardHost;
      /** Overrides for tests; production uses PackageManager/adb.sync/controller.scanFile against opts.adb. */
      transferDeps?: Partial<TransferDeps>;
      role?: SessionRole;
      /** A companion session carries this phone's audio and clipboard, so this one leaves both alone. */
      companion?: boolean;
      /** The companion's echo-suppressed clipboard push, used for clipboard-paste when this session has no clipboard sync of its own. */
      clipboardPush?: (content: string) => bigint;
    },
  ) {
    this.#deps = { ...defaultDeps, ...opts.deps };
    this.#firstPacketTimeoutMs = opts.firstPacketTimeoutMs ?? FIRST_PACKET_TIMEOUT_MS;
    this.#clipboardHost = opts.clipboardHost;
    this.ended = new Promise((resolve) => {
      this.#resolveEnded = resolve;
    });

    // Constructed lazily, not here: a real PackageManager probes adb
    // features on construction, which a fake adb (as tests without their
    // own transferDeps override pass) does not support.
    let pm: PackageManager | undefined;
    const getPm = (): PackageManager => (pm ??= new PackageManager(opts.adb));
    const defaultTransferDeps: TransferDeps = {
      openFile: defaultOpenFile,
      installApk: (stream) => getPm().pushAndInstallStream(toPushReadable(stream), { replaceExisting: true }),
      pushFile: async (path, stream) => {
        await opts.adb.sync.write({ path, readable: toPushReadable(stream) });
      },
      scanFile: async (path) => {
        const controller = this.#client?.controller;
        if (!controller) throw new Error("no control connection to scan the pushed file");
        await controller.scanFile(path);
      },
      removeFile: async (path) => {
        const shell = opts.adb.subprocess.shellProtocol;
        if (!shell) return;
        await shell.spawn(["rm", "-f", path]).wait();
      },
    };
    this.#transfers = createTransferQueue({ ...defaultTransferDeps, ...opts.transferDeps }, opts.log);
    this.#transfers.onProgress((progress) => this.#sink?.transferProgress?.(progress));
  }

  async start(sink: MediaSink): Promise<void> {
    this.#sink = sink;
    try {
      sink.status({ state: "connecting", serial: this.opts.serial });

      let lastError: unknown;
      for (const attempt of [0, 1, 2] as const) {
        if (this.#stopped) return;
        const result = await this.#tryAttempt(attempt, sink);
        if (result === "started") return;
        if (result === "stopped") return;
        lastError = result.error;
      }
      if (!this.#stopped) sink.status({ state: "error", message: String(lastError) });
      this.#markEnded();
    } catch (e) {
      if (!this.#stopped) sink.status({ state: "error", message: String(e) });
      this.#markEnded();
    }
  }

  control(intent: ControlIntent): void {
    const controller = this.#client?.controller;
    if (!controller) return;
    applyIntent(controller, intent, this.#clipboardDeps()).catch((e) => this.opts.log?.(`control failed: ${String(e)}`));
  }

  transfer(localPaths: string[]): void {
    this.#transfers.enqueue(localPaths);
  }

  resize(g: DisplayGeometry): void {
    const controller = this.#client?.controller;
    if (!controller) return;
    controller
      .resizeDisplay({ width: g.width, height: g.height })
      .catch((e) => this.opts.log?.(`resize display failed: ${String(e)}`));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clipboardSync?.stop();
    this.#clipboardSync = null;
    this.#transfers.cancelAll();
    await this.#client?.close().catch(() => {});
  }

  #clipboardDeps(): ApplyIntentDeps {
    const host = this.#clipboardHost;
    if (!host) return {};
    return {
      readPcClipboard: () => host.readText(),
      beginClipboardPush: this.opts.clipboardPush ?? ((content) => this.#clipboardSync?.beginPush(content) ?? 0n),
    };
  }

  get #role(): SessionRole {
    return this.opts.role ?? { kind: "main" };
  }

  /** Only a main session with no companion streams audio and syncs the clipboard itself. */
  get #ownsMedia(): boolean {
    return this.#role.kind === "main" && !this.opts.companion;
  }

  #startApp(client: Client, pkg: string): void {
    client.controller?.startApp(pkg).catch((e) => this.opts.log?.(`start app ${pkg} failed: ${String(e)}`));
  }

  /** client.clipboard blocks on backpressure once clipboardAutosync is on, so this must run for the life of every successful attempt, not just when a clipboard host happens to be wired. */
  #startClipboardSync(client: Client): void {
    const sync = createClipboardSync({
      stream: client.clipboard,
      host: this.#clipboardHost ?? { readText: async () => "", writeText: async () => {} },
      log: this.opts.log,
    });
    this.#clipboardSync = sync;
    void sync.start();
  }

  /**
   * Disabled/errored metadata and a stream that fails before producing
   * anything both surface as one "unsupported" audio-end: whichever it is,
   * the outcome for the session is the same (audio off, one toast), and
   * there is no separate device message to tell them apart. A stream that
   * fails later is "error" while the video goes on, and ends with no
   * reason once the video has ended too (the phone went away, which the
   * status already says).
   */
  async #startAudio(client: Client, sink: MediaSink): Promise<void> {
    if (!this.opts.settings.audio) {
      // Off by the user's own setting: not a failure, no toast.
      sink.audioEnd?.("disabled");
      return;
    }
    // client.audioStream must always be awaited, even with nothing to
    // forward audio to: scrcpy-server is already streaming it once
    // audio:true was passed, and never reading the socket would leave it
    // sitting unread on the adb server relay for the life of the session.
    let metadata: Awaited<Client["audioStream"]>;
    try {
      metadata = await client.audioStream;
    } catch (e) {
      if (this.#stopped) return;
      this.opts.log?.(`audio stream metadata failed: ${String(e)}`);
      sink.audioEnd?.("unsupported");
      return;
    }
    if (this.#stopped) return;
    if (!metadata || metadata.type !== "success") {
      sink.audioEnd?.("unsupported");
      return;
    }

    if (!sink.audioStart) {
      await metadata.stream.cancel().catch(() => {});
      return;
    }

    sink.audioStart({ codec: metadata.codec.webCodecId, sampleRate: 48000, channels: 2 });
    const reader = metadata.stream.getReader();
    let packets = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.#stopped) return;
        if (done) break;
        packets++;
        sink.audioPacket?.(toWireAudio(value));
      }
      if (!this.#stopped) sink.audioEnd?.();
    } catch (e) {
      if (this.#stopped) return;
      this.opts.log?.(`audio stream error: ${String(e)}`);
      if (this.#videoEnded) sink.audioEnd?.();
      else sink.audioEnd?.(packets === 0 ? "unsupported" : "error");
    }
  }

  async #tryAttempt(
    attempt: 0 | 1 | 2,
    sink: MediaSink,
  ): Promise<"started" | "stopped" | { error: unknown }> {
    let client: Client | undefined;
    let outputPromise: Promise<string[]> = Promise.resolve([]);
    try {
      // scrcpy-server unlinks its own jar from the device after launch (cleanup
      // defaults to true), so a jar pushed once before the loop is gone by the
      // second attempt; push it fresh for every attempt.
      const jar = await this.#deps.readServerJar(this.opts.serverPath);
      if (this.#stopped) return "stopped";
      await this.#deps.pushServer(this.opts.adb, jar);
      if (this.#stopped) return "stopped";

      const options = new AdbScrcpyOptions4_1(buildInit(this.opts.settings, attempt, this.#role, this.opts.companion) as never);
      const startPromise = this.#deps.startClient(this.opts.adb, options);
      client = await this.#withTimeout(startPromise, "scrcpy server did not start within", () => {
        // The timeout already moved on to the next attempt (or gave up); a
        // client that shows up after that would otherwise never be closed.
        void startPromise.then((late) => late.close().catch(() => {})).catch(() => {});
      });
      this.#client = client;
      if (this.#stopped) {
        await client.close().catch(() => {});
        this.#client = undefined;
        return "stopped";
      }

      outputPromise = this.#collectOutput(client);

      const video = await this.#withTimeout(client.videoStream, "no video stream within");
      if (this.#stopped) {
        await client.close().catch(() => {});
        this.#client = undefined;
        return "stopped";
      }
      if (!video) throw new Error("scrcpy server started without a video stream");

      const reader = video.stream.getReader();
      const first = await this.#readFirstPacket(reader);
      if (this.#stopped) {
        await client.close().catch(() => {});
        this.#client = undefined;
        return "stopped";
      }
      if (first.done) throw new Error("video stream ended before the first packet");

      sink.videoStart({
        codecId: video.metadata.codec,
        width: video.width,
        height: video.height,
        deviceName: video.metadata.deviceName ?? null,
      });
      sink.status({ state: "streaming", serial: this.opts.serial, model: this.opts.model, deviceId: this.opts.deviceId ?? this.opts.serial });
      sink.videoPacket(toWire(first.value));
      const role = this.#role;
      if (role.kind === "popout") this.#startApp(client, role.pkg);
      if (this.#ownsMedia) {
        this.#startClipboardSync(client);
        void this.#startAudio(client, sink);
      }
      void this.#pump(reader, sink);
      return "started";
    } catch (e) {
      await this.#client?.close().catch(() => {});
      this.#client = undefined;
      const collected = await outputPromise.catch(() => [] as string[]);
      const exitedOutput = e instanceof AdbScrcpyExitedError ? e.output : [];
      const lines = collected.length ? collected : exitedOutput;
      const message = lines.length ? `${String(e)}\n${lines.join("\n")}` : String(e);
      this.opts.log?.(`scrcpy attempt ${attempt} failed: ${message}`);
      return { error: message };
    }
  }

  /** A server that starts but never emits a frame would otherwise hang the attempt forever. */
  async #readFirstPacket(
    reader: ReadableStreamDefaultReader<ScrcpyVideoStreamPacket>,
  ): Promise<ReadableStreamReadResult<ScrcpyVideoStreamPacket>> {
    return this.#withTimeout(reader.read(), "no video packet within");
  }

  /** startClient() and videoStream can hang just as easily as the first packet read if the server never comes up; give them the same bound. */
  async #withTimeout<T>(value: Promise<T> | T, message: string, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(value),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error(`${message} ${this.#firstPacketTimeoutMs}ms`));
          }, this.#firstPacketTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #markEnded(): void {
    if (this.#endedFired) return;
    this.#endedFired = true;
    this.#resolveEnded();
  }

  async #pump(reader: ReadableStreamDefaultReader<ScrcpyVideoStreamPacket>, sink: MediaSink): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.#stopped) return;
        if (done) break;
        sink.videoPacket(toWire(value));
      }
    } catch (e) {
      if (!this.#stopped) this.opts.log?.(`video stream error: ${String(e)}`);
    } finally {
      this.#videoEnded = true;
      if (!this.#stopped) {
        sink.videoEnd();
        this.#markEnded();
      }
    }
  }

  async #collectOutput(client: Client): Promise<string[]> {
    const lines: string[] = [];
    const reader = client.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lines.push(value);
        this.opts.log?.(value);
      }
    } catch {
      // the output stream errors when the server process exits abruptly; nothing to act on here
    }
    return lines;
  }
}
