import { readFile } from "node:fs/promises";
import { decodeRecording, type RecordedEvent } from "../shared/recording";
import type { ControlIntent } from "../shared/wire";
import type { MediaSink, MediaSource } from "./media-source";

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export class ReplaySource implements MediaSource {
  readonly controls: ControlIntent[] = [];

  private readonly clock: Clock;
  private readonly loop: boolean;
  private sink: MediaSink | null = null;
  private timers: unknown[] = [];

  constructor(
    private readonly file: string,
    private readonly events: RecordedEvent[],
    opts?: { clock?: Clock; loop?: boolean },
  ) {
    this.clock = opts?.clock ?? (globalThis as unknown as Clock);
    this.loop = opts?.loop ?? false;
  }

  static async fromFile(file: string, opts?: { loop?: boolean }): Promise<ReplaySource> {
    const bytes = await readFile(file);
    const events = decodeRecording(bytes);
    return new ReplaySource(file, events, opts);
  }

  async start(sink: MediaSink): Promise<void> {
    this.sink = sink;
    sink.status({ state: "replay", file: this.file });
    this.schedule();
  }

  control(intent: ControlIntent): void {
    this.controls.push(intent);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers = [];
  }

  private schedule(): void {
    const sink = this.sink;
    if (!sink) return;

    const lastIndex = this.events.length - 1;
    this.events.forEach((event, index) => {
      const fire = () => {
        this.dispatch(sink, event);
        if (index === lastIndex) {
          if (this.loop) this.schedule();
          else sink.videoEnd();
        }
      };
      if (event.t === 0) fire();
      else this.timers.push(this.clock.setTimeout(fire, event.t));
    });
  }

  private dispatch(sink: MediaSink, event: RecordedEvent): void {
    if (event.kind === "video-start") sink.videoStart(event.info);
    else if (event.kind === "video-packet") sink.videoPacket(event.packet);
    else sink.postureLine?.(event.line);
  }
}
