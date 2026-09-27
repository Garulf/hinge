import type { AppEntry } from "./app-catalog";
import type { PostureReading } from "./posture";

export type WireMediaPacket =
  | { type: "configuration"; data: Uint8Array }
  | { type: "data"; keyframe: boolean | null; pts: number | null; data: Uint8Array }
  | { type: "session"; width: number; height: number; isClientResize: boolean };

export interface VideoStreamInfo { codecId: number; width: number; height: number; deviceName: string | null }

export type WireAudioPacket = { type: "configuration"; data: Uint8Array } | { type: "data"; pts: number | null; data: Uint8Array };

/** codec is the WebCodecs AudioDecoder codec string (e.g. "opus"), not a numeric id like VideoStreamInfo's. */
export interface AudioStreamInfo { codec: string; sampleRate: number; channels: number }

export type AudioEndReason = "unsupported" | "error" | "disabled";

export type SessionStatus =
  | { state: "no-device" }
  | { state: "unauthorized"; serial: string }
  | { state: "connecting"; serial: string }
  /** deviceId is the phone's identity (its ro.serialno), the same across USB and Wi-Fi; serial is the adb transport it streams over. */
  | { state: "streaming"; serial: string; model: string | null; deviceId: string }
  | { state: "replay"; file: string }
  | { state: "error"; message: string };

export type TouchAction = "down" | "move" | "up" | "cancel";
export type ControlIntent =
  | { type: "touch"; action: TouchAction; pointerId: number; x: number; y: number; videoWidth: number; videoHeight: number; pressure: number; buttons: number }
  | { type: "scroll"; x: number; y: number; videoWidth: number; videoHeight: number; scrollX: number; scrollY: number; buttons: number }
  | { type: "key"; action: "down" | "up"; keyCode: number; repeat: number; metaState: number }
  | { type: "text"; text: string }
  | { type: "back-or-screen-on"; action: "down" | "up" }
  | { type: "reset-video" }
  | { type: "display-power"; on: boolean }
  | { type: "expand-notifications" }
  | { type: "expand-settings" }
  | { type: "collapse-panels" }
  | { type: "rotate-device" }
  /**
   * Unresolved: main fills in the PC clipboard content and (for a real
   * paste) a fresh sequence number, since neither is available to the
   * renderer. asText true injects the text directly (MOD+Shift+v); false
   * sets the device clipboard and pastes (Ctrl+V, MOD+v).
   */
  | { type: "clipboard-paste"; asText: boolean };

export interface PostureMessage { kind: "posture"; reading: PostureReading }

export type TransportKind = "usb" | "tcp" | "mdns";

/** device is Tango's Device.device (the codename), used with model to dedupe the same phone listed twice (ip:port and mDNS serial). */
export interface DeviceSummary {
  serial: string;
  state: string;
  model: string | null;
  device: string | null;
  transport: TransportKind;
}

export type DeviceCommand =
  | { type: "list" }
  | { type: "pair"; hostPort: string; code: string }
  | { type: "connect"; serial: string }
  | { type: "switch-to-wifi"; serial: string }
  | { type: "disconnect"; serial: string };

export type DeviceCommandResult =
  | { type: "list"; devices: DeviceSummary[] }
  | { type: "pair"; ok: boolean; connectedAddress: string | null; message?: string }
  | { type: "connect"; ok: boolean; message?: string }
  | { type: "switch-to-wifi"; ok: boolean; address: string | null; message?: string }
  | { type: "disconnect"; ok: boolean; message?: string };

export type TransferKind = "install" | "push";
export type TransferState = "queued" | "running" | "done" | "error" | "cancelled";

export interface TransferProgress {
  id: string;
  name: string;
  kind: TransferKind;
  state: TransferState;
  bytesWritten: number;
  totalBytes: number;
  message?: string;
}

export type MainToRenderer =
  | { kind: "video-start"; info: VideoStreamInfo }
  | { kind: "video-packet"; packet: WireMediaPacket }
  | { kind: "video-end" }
  | { kind: "audio-start"; info: AudioStreamInfo }
  | { kind: "audio-packet"; packet: WireAudioPacket }
  /**
   * reason "unsupported" covers both the device metadata reporting
   * "disabled"/"errored" and the audio stream failing before it produced
   * anything; "error" is a stream that failed partway while the video
   * went on; "disabled" is audio turned off by the user's own settings,
   * not a failure; absent for a clean end (session stop, or the whole
   * stream closing).
   */
  | { kind: "audio-end"; reason?: AudioEndReason }
  | { kind: "status"; status: SessionStatus }
  | { kind: "transfer-progress"; progress: TransferProgress }
  | { kind: "device-command-result"; id: string; result: DeviceCommandResult }
  /** The deduped device list, pushed on every change so an open device panel stays current. */
  | { kind: "devices"; devices: DeviceSummary[] }
  /** Something the user asked for could not happen (too many pop-outs, say); shown as a toast. */
  | { kind: "notice"; text: string }
  /** The tray's "Open app…": show the app picker. */
  | { kind: "open-picker" }
  /** The answer to "apps-request"; icons are data: URLs by package, error says why the list is partial or empty. */
  | { kind: "apps"; apps: AppEntry[]; recents: string[]; icons: Record<string, string>; error: string | null }
  | PostureMessage;

export type RendererToMain =
  | { kind: "ready" }
  | { kind: "control"; intent: ControlIntent }
  /** Local PC file paths, already resolved in the preload via webUtils.getPathForFile; main decides install vs. push by extension. */
  | { kind: "drop-files"; paths: string[] }
  | { kind: "device-command"; id: string; command: DeviceCommand }
  /** A pop-out's canvas size in CSS px, sent on every change; main debounces it into a display resize. */
  | { kind: "viewport"; width: number; height: number; dpr: number }
  | { kind: "retry" }
  | { kind: "popout-open"; pkg: string }
  /** Pops out whatever app is in the foreground on the phone. */
  | { kind: "popout-current" }
  | { kind: "apps-request" }
  | { kind: "create-shortcut"; pkg: string };

/** The main window's requests about apps and pop-outs, which bindSource hands to its owner instead of the source. */
export type AppRequest = Extract<RendererToMain, { kind: "popout-open" | "popout-current" | "apps-request" | "create-shortcut" }>;

type LooseMediaPacket =
  | { type: "configuration"; data: Uint8Array }
  | { type: "data"; keyframe?: boolean; pts?: bigint; data: Uint8Array }
  | { type: "session"; width: number; height: number; isClientResize: boolean };

function ownedCopy(data: Uint8Array): Uint8Array {
  return data.slice();
}

export function toWire(packet: LooseMediaPacket): WireMediaPacket {
  if (packet.type === "session") return packet;
  if (packet.type === "configuration") return { type: "configuration", data: ownedCopy(packet.data) };
  return {
    type: "data",
    keyframe: packet.keyframe ?? null,
    pts: packet.pts === undefined ? null : Number(packet.pts),
    data: ownedCopy(packet.data),
  };
}

type LooseAudioPacket = { type: "configuration"; data: Uint8Array } | { type: "data"; pts?: bigint; data: Uint8Array };

export function toWireAudio(packet: LooseAudioPacket): WireAudioPacket {
  if (packet.type === "configuration") return { type: "configuration", data: ownedCopy(packet.data) };
  return { type: "data", pts: packet.pts === undefined ? null : Number(packet.pts), data: ownedCopy(packet.data) };
}

export function transferablesOf(msg: MainToRenderer): ArrayBuffer[] {
  if (msg.kind === "video-packet") {
    if (msg.packet.type === "session") return [];
    return [msg.packet.data.buffer as ArrayBuffer];
  }
  if (msg.kind === "audio-packet") return [msg.packet.data.buffer as ArrayBuffer];
  return [];
}
