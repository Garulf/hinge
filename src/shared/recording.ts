import type { VideoStreamInfo, WireMediaPacket } from "./wire";

export type RecordedEvent =
  | { t: number; kind: "video-start"; info: VideoStreamInfo }
  | { t: number; kind: "video-packet"; packet: WireMediaPacket }
  | { t: number; kind: "posture-line"; line: string };

export const RECORDING_MAGIC = new TextEncoder().encode("HREC1\n");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function hasPacketData(ev: RecordedEvent): ev is RecordedEvent & { kind: "video-packet"; packet: { type: "configuration" | "data"; data: Uint8Array } } {
  return ev.kind === "video-packet" && (ev.packet.type === "configuration" || ev.packet.type === "data");
}

export function encodeEvent(ev: RecordedEvent): Uint8Array {
  let header: unknown = ev;
  let data: Uint8Array = new Uint8Array(0);

  if (hasPacketData(ev)) {
    const { data: packetData, ...packetRest } = ev.packet;
    data = packetData;
    header = { ...ev, packet: packetRest };
  }

  const headerBytes = encoder.encode(JSON.stringify(header));
  return concat([u32le(headerBytes.length), headerBytes, u32le(data.length), data]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function decodeRecording(bytes: Uint8Array): RecordedEvent[] {
  if (!bytesEqual(bytes.subarray(0, RECORDING_MAGIC.length), RECORDING_MAGIC)) {
    throw new Error("not a hinge recording");
  }

  const events: RecordedEvent[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = RECORDING_MAGIC.length;

  while (offset + 4 <= bytes.length) {
    const headerLen = view.getUint32(offset, true);
    offset += 4;
    if (offset + headerLen > bytes.length) break;
    const headerBytes = bytes.subarray(offset, offset + headerLen);
    offset += headerLen;

    if (offset + 4 > bytes.length) break;
    const dataLen = view.getUint32(offset, true);
    offset += 4;
    if (offset + dataLen > bytes.length) break;
    const data = bytes.subarray(offset, offset + dataLen);
    offset += dataLen;

    const header = JSON.parse(decoder.decode(headerBytes)) as RecordedEvent;
    if (hasPacketData(header)) header.packet.data = new Uint8Array(data);
    events.push(header);
  }

  return events;
}
