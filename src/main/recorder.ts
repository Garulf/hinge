import { encodeEvent, RECORDING_MAGIC, type RecordedEvent } from "../shared/recording";
import type { MediaSink } from "./media-source";

export function teeToRecording(sink: MediaSink, write: (chunk: Uint8Array) => void, now: () => number): MediaSink {
  let wroteMagic = false;
  let firstNow: number | null = null;

  function relTime(): number {
    if (firstNow === null) firstNow = now();
    return now() - firstNow;
  }

  function record(build: (t: number) => RecordedEvent): void {
    if (!wroteMagic) {
      wroteMagic = true;
      write(RECORDING_MAGIC);
    }
    write(encodeEvent(build(relTime())));
  }

  return {
    videoStart(info) {
      record((t) => ({ t, kind: "video-start", info }));
      sink.videoStart(info);
    },
    videoPacket(packet) {
      record((t) => ({ t, kind: "video-packet", packet }));
      sink.videoPacket(packet);
    },
    videoEnd() {
      sink.videoEnd();
    },
    status(status) {
      sink.status(status);
    },
    postureLine(line) {
      record((t) => ({ t, kind: "posture-line", line }));
      sink.postureLine?.(line);
    },
  };
}
