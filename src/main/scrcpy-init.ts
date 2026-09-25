export interface StreamSettings {
  videoCodec: "h264" | "h265";
  videoBitRate: number;
  maxSize: number;
  maxFps: number;
  audio: boolean;
}

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  videoCodec: "h264",
  videoBitRate: 16_000_000,
  maxSize: 0,
  maxFps: 0,
  audio: false,
};

export function buildInit(s: StreamSettings, attempt: 0 | 1 | 2): Record<string, unknown> {
  return {
    video: true,
    audio: s.audio,
    control: true,
    videoCodec: attempt === 2 ? "h264" : s.videoCodec,
    videoBitRate: s.videoBitRate,
    maxSize: s.maxSize,
    maxFps: s.maxFps,
    ignoreVideoEncoderConstraints: attempt > 0,
    // Windows Firewall prompts for a reverse tunnel (listens on all interfaces); a
    // forward tunnel only binds localhost on the device side.
    tunnelForward: true,
    // ClipboardStream blocks on backpressure (M5 drains it); off until then.
    clipboardAutosync: false,
    powerOn: true,
    stayAwake: false,
    sendDeviceMeta: true,
    sendFrameMeta: true,
  };
}
