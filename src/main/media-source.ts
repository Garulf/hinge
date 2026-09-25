import type { PostureReading } from "../shared/posture";
import type { AudioStreamInfo, ControlIntent, DeviceCommand, DeviceCommandResult, SessionStatus, TransferProgress, VideoStreamInfo, WireAudioPacket, WireMediaPacket } from "../shared/wire";

export interface MediaSink {
  videoStart(info: VideoStreamInfo): void;
  videoPacket(packet: WireMediaPacket): void;
  videoEnd(): void;
  status(status: SessionStatus): void;
  postureLine?(line: string): void;
  posture?(reading: PostureReading): void;
  /** Absent in contexts that never forward audio (e.g. the probe mode); a source must skip starting audio entirely rather than calling these unguarded. */
  audioStart?(info: AudioStreamInfo): void;
  audioPacket?(packet: WireAudioPacket): void;
  audioEnd?(reason?: "unsupported"): void;
  transferProgress?(progress: TransferProgress): void;
}

export interface MediaSource {
  start(sink: MediaSink): Promise<void>;
  control(intent: ControlIntent): void;
  stop(): Promise<void>;
  /** Absent in contexts with nothing to push files to (e.g. the probe mode or replay). */
  transfer?(localPaths: string[]): void;
  /** Absent in contexts with no adb server access (e.g. replay); device listing, pairing and switching are then all unavailable. */
  handleDeviceCommand?(command: DeviceCommand): Promise<DeviceCommandResult>;
  /**
   * Resolves when the source ends on its own (stream closed, retries exhausted),
   * as opposed to being stopped explicitly. Absent for sources that never end
   * this way. A caller that owns several sources can use it to notice a dead
   * one and reconnect without waiting for an unrelated external event.
   */
  ended?: Promise<void>;
}
