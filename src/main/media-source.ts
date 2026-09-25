import type { ControlIntent, SessionStatus, VideoStreamInfo, WireMediaPacket } from "../shared/wire";

export interface MediaSink {
  videoStart(info: VideoStreamInfo): void;
  videoPacket(packet: WireMediaPacket): void;
  videoEnd(): void;
  status(status: SessionStatus): void;
  postureLine?(line: string): void;
}

export interface MediaSource {
  start(sink: MediaSink): Promise<void>;
  control(intent: ControlIntent): void;
  stop(): Promise<void>;
}
