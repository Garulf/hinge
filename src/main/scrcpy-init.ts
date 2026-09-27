import type { DisplayGeometry } from "../shared/popout";
import type { Settings } from "./settings";

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
  audio: true,
};

export function toStreamSettings(settings: Settings): StreamSettings {
  return {
    videoCodec: settings.videoCodec,
    videoBitRate: settings.videoBitRate,
    maxSize: settings.maxSize,
    maxFps: settings.maxFps,
    audio: settings.audio,
  };
}

/**
 * Several hinge servers run on one phone at once (main, companion, pop-outs).
 * Each needs its own scid, which names its adb socket, and its own jar path,
 * because a server deletes its jar once it has launched.
 */
export interface ServerInstance {
  scid: string;
  jarPath: string;
}

export function newServerInstance(): ServerInstance {
  const scid = Math.floor(Math.random() * 0x80000000).toString(16);
  return { scid, jarPath: `/data/local/tmp/hinge-scrcpy-${scid}.jar` };
}

/** A pop-out streams one app on its own virtual display; the main session streams the phone's screen. */
export type SessionRole = { kind: "main" } | { kind: "popout"; pkg: string; geometry: DisplayGeometry };

const MAIN_ROLE: SessionRole = { kind: "main" };

/** A companion session, when present, owns the phone's audio and clipboard, so the video sessions leave both off. */
export function buildInit(s: StreamSettings, attempt: 0 | 1 | 2, role: SessionRole = MAIN_ROLE, companion = false): Record<string, unknown> {
  const init = mainInit(s, attempt);
  if (role.kind === "popout") return { ...init, ...popoutOverrides(role.geometry) };
  if (companion) return { ...init, audio: false, clipboardAutosync: false };
  return init;
}

function popoutOverrides(g: DisplayGeometry): Record<string, unknown> {
  return {
    audio: false,
    clipboardAutosync: false,
    maxSize: 0,
    newDisplay: `${g.width}x${g.height}/${g.dpi}`,
    vdSystemDecorations: false,
    vdDestroyContent: false,
    displayImePolicy: "hide",
    // Waking the phone would turn its main screen on for an app shown only on the PC.
    powerOn: false,
  };
}

export function buildCompanionInit(s: StreamSettings): Record<string, unknown> {
  return {
    video: false,
    audio: s.audio,
    control: true,
    clipboardAutosync: true,
    tunnelForward: true,
    sendDeviceMeta: false,
    powerOn: false,
    stayAwake: false,
  };
}

function mainInit(s: StreamSettings, attempt: 0 | 1 | 2): Record<string, unknown> {
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
    // ClipboardSync drains client.clipboard continuously, which is
    // required whenever this is on: the stream blocks on backpressure.
    clipboardAutosync: true,
    powerOn: true,
    stayAwake: false,
    sendDeviceMeta: true,
    sendFrameMeta: true,
  };
}
