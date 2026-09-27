import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyOptions4_1, type AdbScrcpyClient } from "@yume-chan/adb-scrcpy";
import { pumpAudio, type AudioSink } from "./audio-forward";
import { createClipboardSync, type ClipboardHost, type ClipboardSync } from "./clipboard-sync";
import { buildCompanionInit, type StreamSettings } from "./scrcpy-init";
import { defaultServerDeps, type ScrcpyServerDeps } from "./scrcpy-session";

export type { AudioSink } from "./audio-forward";

type Client = AdbScrcpyClient<AdbScrcpyOptions4_1<any>>;

const NO_CLIPBOARD_HOST: ClipboardHost = { readText: async () => "", writeText: async () => {} };

/**
 * A video-less scrcpy server that carries one phone's audio and clipboard
 * while its screens are streamed by other sessions. It never retries on its
 * own: `ended` tells the owner to start a new one.
 */
export class CompanionSession {
  #client: Client | undefined;
  #stopped = false;
  #exited = false;
  #clipboardSync: ClipboardSync | null = null;
  #resolveEnded!: () => void;
  readonly ended: Promise<void>;
  readonly #deps: ScrcpyServerDeps;

  constructor(
    private readonly opts: {
      adb: Adb;
      serverPath: string;
      settings: StreamSettings;
      clipboardHost?: ClipboardHost;
      log?: (line: string) => void;
      deps?: Partial<ScrcpyServerDeps>;
    },
  ) {
    this.#deps = { ...defaultServerDeps, ...opts.deps };
    this.ended = new Promise((resolve) => {
      this.#resolveEnded = resolve;
    });
  }

  async start(sink: AudioSink): Promise<void> {
    try {
      const client = await this.#startClient();
      if (!client) return;
      this.#client = client;
      void this.#drainOutput(client);
      void client.exited.then(() => this.#onExited());
      this.#startClipboardSync(client);
      void pumpAudio(client, sink, {
        enabled: this.opts.settings.audio,
        stopped: () => this.#stopped,
        sessionEnded: () => this.#exited,
        log: this.opts.log,
      });
    } catch (e) {
      this.opts.log?.(`companion session failed to start: ${String(e)}`);
      if (!this.#stopped) this.#resolveEnded();
    }
  }

  beginPush(content: string): bigint {
    return this.#clipboardSync?.beginPush(content) ?? 0n;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clipboardSync?.stop();
    this.#clipboardSync = null;
    await this.#client?.close().catch(() => {});
  }

  async #startClient(): Promise<Client | undefined> {
    const jar = await this.#deps.readServerJar(this.opts.serverPath);
    if (this.#stopped) return undefined;
    await this.#deps.pushServer(this.opts.adb, jar);
    if (this.#stopped) return undefined;
    const client = await this.#deps.startClient(this.opts.adb, new AdbScrcpyOptions4_1(buildCompanionInit(this.opts.settings) as never));
    if (this.#stopped) {
      await client.close().catch(() => {});
      return undefined;
    }
    return client;
  }

  #onExited(): void {
    this.#exited = true;
    if (!this.#stopped) this.#resolveEnded();
  }

  /** client.clipboard blocks the server on backpressure once clipboardAutosync is on, so it is drained for the client's whole life. */
  #startClipboardSync(client: Client): void {
    const sync = createClipboardSync({ stream: client.clipboard, host: this.opts.clipboardHost ?? NO_CLIPBOARD_HOST, log: this.opts.log });
    this.#clipboardSync = sync;
    void sync.start();
  }

  async #drainOutput(client: Client): Promise<void> {
    const reader = client.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.opts.log?.(value);
      }
    } catch {
      // the output stream errors when the server process exits abruptly; `exited` reports that
    }
  }
}
