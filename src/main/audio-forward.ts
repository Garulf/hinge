import type { AdbScrcpyAudioStreamMetadata } from "@yume-chan/adb-scrcpy";
import { toWireAudio, type AudioEndReason, type AudioStreamInfo, type WireAudioPacket } from "../shared/wire";

export interface AudioSink {
  audioStart?(info: AudioStreamInfo): void;
  audioPacket?(p: WireAudioPacket): void;
  audioEnd?(reason?: AudioEndReason): void;
}

export interface AudioClient {
  readonly audioStream: Promise<AdbScrcpyAudioStreamMetadata> | undefined;
}

export interface PumpAudioOptions {
  /** The user's audio setting. */
  enabled: boolean;
  stopped(): boolean;
  /** True once the session's own stream is over (the phone went away), after which an audio error needs no reason of its own. */
  sessionEnded(): boolean;
  log?: (line: string) => void;
}

/**
 * Disabled/errored metadata and a stream that fails before producing
 * anything both surface as one "unsupported" audio-end: whichever it is,
 * the outcome for the session is the same (audio off, one toast), and
 * there is no separate device message to tell them apart. A stream that
 * fails later is "error" while the session goes on, and ends with no
 * reason once the session has ended too (the phone went away, which the
 * status already says).
 */
export async function pumpAudio(client: AudioClient, sink: AudioSink, opts: PumpAudioOptions): Promise<void> {
  if (!opts.enabled) {
    // Off by the user's own setting: not a failure, no toast.
    sink.audioEnd?.("disabled");
    return;
  }
  // client.audioStream must always be awaited, even with nothing to
  // forward audio to: scrcpy-server is already streaming it once
  // audio:true was passed, and never reading the socket would leave it
  // sitting unread on the adb server relay for the life of the session.
  let metadata: AdbScrcpyAudioStreamMetadata | undefined;
  try {
    metadata = await client.audioStream;
  } catch (e) {
    if (opts.stopped()) return;
    opts.log?.(`audio stream metadata failed: ${String(e)}`);
    sink.audioEnd?.("unsupported");
    return;
  }
  if (opts.stopped()) return;
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
      if (opts.stopped()) return;
      if (done) break;
      packets++;
      sink.audioPacket?.(toWireAudio(value));
    }
    if (!opts.stopped()) sink.audioEnd?.();
  } catch (e) {
    if (opts.stopped()) return;
    opts.log?.(`audio stream error: ${String(e)}`);
    if (opts.sessionEnded()) sink.audioEnd?.();
    else sink.audioEnd?.(packets === 0 ? "unsupported" : "error");
  }
}
