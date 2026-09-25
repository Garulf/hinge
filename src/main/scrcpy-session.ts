import { readFile } from "node:fs/promises";
import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptions4_1 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, type ScrcpyVideoStreamPacket } from "@yume-chan/scrcpy";
import { PushReadableStream } from "@yume-chan/stream-extra";
import { applyIntent } from "./intents";
import type { MediaSink, MediaSource } from "./media-source";
import { buildInit, type StreamSettings } from "./scrcpy-init";
import { toWire, type ControlIntent } from "../shared/wire";

type Client = AdbScrcpyClient<AdbScrcpyOptions4_1<any>>;

export class ScrcpySession implements MediaSource {
  #client: Client | undefined;
  #stopped = false;
  #endedFired = false;
  #resolveEnded!: () => void;
  readonly ended: Promise<void>;

  constructor(
    private readonly opts: {
      adb: Adb;
      serial: string;
      model: string | null;
      serverPath: string;
      settings: StreamSettings;
      log?: (line: string) => void;
    },
  ) {
    this.ended = new Promise((resolve) => {
      this.#resolveEnded = resolve;
    });
  }

  async start(sink: MediaSink): Promise<void> {
    try {
      sink.status({ state: "connecting", serial: this.opts.serial });
      const jar = await readFile(this.opts.serverPath);
      if (this.#stopped) return;
      await AdbScrcpyClient.pushServer(
        this.opts.adb,
        new PushReadableStream<Uint8Array>((controller) => {
          controller.enqueue(new Uint8Array(jar));
          controller.close();
        }),
      );
      if (this.#stopped) return;

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
    applyIntent(controller, intent).catch((e) => this.opts.log?.(`control failed: ${String(e)}`));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#client?.close().catch(() => {});
  }

  async #tryAttempt(
    attempt: 0 | 1 | 2,
    sink: MediaSink,
  ): Promise<"started" | "stopped" | { error: unknown }> {
    let client: Client | undefined;
    let outputPromise: Promise<string[]> = Promise.resolve([]);
    try {
      const options = new AdbScrcpyOptions4_1(buildInit(this.opts.settings, attempt) as never);
      client = await AdbScrcpyClient.start(this.opts.adb, DefaultServerPath, options);
      this.#client = client;
      if (this.#stopped) {
        await client.close().catch(() => {});
        this.#client = undefined;
        return "stopped";
      }

      outputPromise = this.#collectOutput(client);

      const video = await client.videoStream;
      if (this.#stopped) {
        await client.close().catch(() => {});
        this.#client = undefined;
        return "stopped";
      }
      if (!video) throw new Error("scrcpy server started without a video stream");

      const reader = video.stream.getReader();
      const first = await reader.read();
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
      sink.status({ state: "streaming", serial: this.opts.serial, model: this.opts.model });
      sink.videoPacket(toWire(first.value));
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

  #markEnded(): void {
    if (this.#endedFired) return;
    this.#endedFired = true;
    this.#resolveEnded();
  }

  async #pump(reader: ReadableStreamDefaultReader<ScrcpyVideoStreamPacket>, sink: MediaSink): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.videoPacket(toWire(value));
      }
    } catch (e) {
      if (!this.#stopped) this.opts.log?.(`video stream error: ${String(e)}`);
    } finally {
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
