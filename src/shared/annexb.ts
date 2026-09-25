function startCodeLength(stream: Uint8Array, i: number): number {
  if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) return 3;
  if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 0 && stream[i + 3] === 1) return 4;
  return 0;
}

export function splitNalUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  let i = 0;
  while (i <= stream.length - 3) {
    const scLen = startCodeLength(stream, i);
    if (scLen > 0) {
      starts.push(i);
      i += scLen;
    } else {
      i++;
    }
  }

  const nals: Uint8Array[] = [];
  for (let n = 0; n < starts.length; n++) {
    const start = starts[n];
    const end = n + 1 < starts.length ? starts[n + 1] : stream.length;
    nals.push(stream.subarray(start, end));
  }
  return nals;
}

export function nalType(nal: Uint8Array): number {
  const scLen = nal[2] === 1 ? 3 : 4;
  return nal[scLen] & 0x1f;
}

export interface AccessUnit { config: Uint8Array | null; data: Uint8Array; keyframe: boolean }

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_SEI = 6;
const NAL_AUD = 9;
const NAL_SLICE_NON_IDR = 1;
const NAL_SLICE_IDR = 5;

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function groupAccessUnits(nals: Uint8Array[]): AccessUnit[] {
  const accessUnits: AccessUnit[] = [];
  let pendingConfig: Uint8Array[] = [];
  let prefix: Uint8Array[] = [];

  for (const nal of nals) {
    const type = nalType(nal);
    if (type === NAL_SPS || type === NAL_PPS) {
      pendingConfig.push(nal);
    } else if (type === NAL_SEI || type === NAL_AUD) {
      prefix.push(nal);
    } else if (type === NAL_SLICE_NON_IDR || type === NAL_SLICE_IDR) {
      accessUnits.push({
        config: pendingConfig.length > 0 ? concatBytes(pendingConfig) : null,
        data: concatBytes([...prefix, nal]),
        keyframe: type === NAL_SLICE_IDR,
      });
      pendingConfig = [];
      prefix = [];
    }
  }

  return accessUnits;
}
