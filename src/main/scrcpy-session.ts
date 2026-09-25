import { readFile } from "node:fs/promises";
import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptions4_1 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, type ScrcpyVideoStreamPacket } from "@yume-chan/scrcpy";
import { PushReadableStream } from "@yume-chan/stream-extra";
import { applyIntent } from "./intents";
import type { MediaSink, MediaSource } from "./media-source";
import { buildInit, type StreamSettings } from "./scrcpy-init";
import { toWire, type ControlIntent } from "../shared/wire";

export class ScrcpySession implements MediaSource {
  #client: AdbScrcpyClient<AdbScrcpyOptions4_1<any>> | undefined;
  #stopped = false;

  constructor(
    private readonly opts: {
      adb: Adb;
      serial: string;
      model: string | null;
      serverPath: string;
      settings: StreamSettings;
      log?: (line: string) => void;
    },
  ) {}

  async start(sink: MediaSink): Promise<void> {
    sink.status({ state: "connecting", serial: this.opts.serial });
    const jar = await readFile(this.opts.serverPath);
    await AdbScrcpyClient.pushServer(
      this.opts.adb,
      new PushReadableStream<Uint8Array>((controller) => {
        controller.enqueue(new Uint8Array(jar));
        controller.close();
      }),
    );

    let lastError: unknown;
    for (const attempt of [0, 1, 2] as const) {
      let client: AdbScrcpyClient<AdbScrcpyOptions4_1<any>> | undefined;
      try {
        const options = new AdbScrcpyOptions4_1(buildInit(this.opts.settings, attempt) as never);
        client = await AdbScrcpyClient.start(this.opts.adb, DefaultServerPath, options);
        const video = await client.videoStream;
        if (!video) throw new Error("scrcpy server started without a video stream");

        const reader = video.stream.getReader();
        const first = await reader.read();
        if (first.done) throw new Error("video stream ended before the first packet");

        this.#client = client;
        sink.videoStart({
          codecId: video.metadata.codec,
          width: video.width,
          height: video.height,
          deviceName: video.metadata.deviceName ?? null,
        });
        sink.status({ state: "streaming", serial: this.opts.serial, model: this.opts.model });
        sink.videoPacket(toWire(first.value));
        void this.#pump(reader, sink);
        void this.#logOutput(client);
        return;
      } catch (e) {
        const output = e instanceof AdbScrcpyExitedError ? `\n${e.output.join("\n")}` : "";
        lastError = `${String(e)}${output}`;
        this.opts.log?.(`scrcpy attempt ${attempt} failed: ${String(lastError)}`);
        await client?.close().catch(() => {});
      }
    }
    sink.status({ state: "error", message: String(lastError) });
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
      if (!this.#stopped) sink.videoEnd();
    }
  }

  async #logOutput(client: AdbScrcpyClient<AdbScrcpyOptions4_1<any>>): Promise<void> {
    const reader = client.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.opts.log?.(value);
      }
    } catch {
      // the output stream ends when the server process exits; nothing to act on here
    }
  }
}
