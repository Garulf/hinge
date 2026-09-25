export type WireMediaPacket =
  | { type: "configuration"; data: Uint8Array }
  | { type: "data"; keyframe: boolean | null; pts: number | null; data: Uint8Array }
  | { type: "session"; width: number; height: number; isClientResize: boolean };

export interface VideoStreamInfo { codecId: number; width: number; height: number; deviceName: string | null }

export type SessionStatus =
  | { state: "no-device" }
  | { state: "unauthorized"; serial: string }
  | { state: "connecting"; serial: string }
  | { state: "streaming"; serial: string; model: string | null }
  | { state: "replay"; file: string }
  | { state: "error"; message: string };

export type TouchAction = "down" | "move" | "up" | "cancel";
export type ControlIntent =
  | { type: "touch"; action: TouchAction; pointerId: number; x: number; y: number; videoWidth: number; videoHeight: number; pressure: number; buttons: number }
  | { type: "scroll"; x: number; y: number; videoWidth: number; videoHeight: number; scrollX: number; scrollY: number; buttons: number }
  | { type: "key"; action: "down" | "up"; keyCode: number; repeat: number; metaState: number }
  | { type: "text"; text: string }
  | { type: "back-or-screen-on"; action: "down" | "up" };

export type MainToRenderer =
  | { kind: "video-start"; info: VideoStreamInfo }
  | { kind: "video-packet"; packet: WireMediaPacket }
  | { kind: "video-end" }
  | { kind: "status"; status: SessionStatus };

export type RendererToMain =
  | { kind: "ready" }
  | { kind: "control"; intent: ControlIntent };

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

export function transferablesOf(msg: MainToRenderer): ArrayBuffer[] {
  if (msg.kind !== "video-packet") return [];
  if (msg.packet.type === "session") return [];
  return [msg.packet.data.buffer as ArrayBuffer];
}
