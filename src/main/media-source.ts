import type { PostureReading } from "../shared/posture";
import type { ControlIntent, SessionStatus, VideoStreamInfo, WireMediaPacket } from "../shared/wire";

export interface MediaSink {
  videoStart(info: VideoStreamInfo): void;
  videoPacket(packet: WireMediaPacket): void;
  videoEnd(): void;
  status(status: SessionStatus): void;
  postureLine?(line: string): void;
  posture?(reading: PostureReading): void;
}

export interface MediaSource {
  start(sink: MediaSink): Promise<void>;
  control(intent: ControlIntent): void;
  stop(): Promise<void>;
  /**
   * Resolves when the source ends on its own (stream closed, retries exhausted),
   * as opposed to being stopped explicitly. Absent for sources that never end
   * this way. A caller that owns several sources can use it to notice a dead
   * one and reconnect without waiting for an unrelated external event.
   */
  ended?: Promise<void>;
}
