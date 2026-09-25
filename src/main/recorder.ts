import { encodeEvent, RECORDING_MAGIC, type RecordedEvent } from "../shared/recording";
import type { MediaSink } from "./media-source";
import type { QueuedWriter } from "./queued-writer";

/**
 * Tees video and posture events into a recording via a QueuedWriter. Once the
 * underlying stream errors, further recording writes are dropped (the writer
 * itself refuses them) and a sticky "Recording failed" error status is posted
 * once and then re-posted in place of every later status, so mirroring can
 * keep running without the user believing the recording is still working.
 */
export function teeToRecording(sink: MediaSink, writer: QueuedWriter, now: () => number, log?: (line: string) => void): MediaSink {
  let wroteMagic = false;
  let firstNow: number | null = null;
  let stickyMessage: string | null = null;

  writer.onError((e) => {
    stickyMessage = `Recording failed: ${String(e)}`;
    log?.(stickyMessage);
    sink.status({ state: "error", message: stickyMessage });
  });

  function relTime(): number {
    if (firstNow === null) firstNow = now();
    return now() - firstNow;
  }

  function record(build: (t: number) => RecordedEvent): void {
    if (writer.failed) return;
    if (!wroteMagic) {
      wroteMagic = true;
      writer.write(RECORDING_MAGIC);
    }
    writer.write(encodeEvent(build(relTime())));
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
      if (stickyMessage) {
        sink.status({ state: "error", message: stickyMessage });
        return;
      }
      sink.status(status);
    },
    postureLine(line) {
      record((t) => ({ t, kind: "posture-line", line }));
      sink.postureLine?.(line);
    },
    posture(reading) {
      // Not itself recorded: the raw postureLine text is what's persisted,
      // and a replay reparses it back into the same readings.
      sink.posture?.(reading);
    },
  };
}
