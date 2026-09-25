export type Posture = "closed" | "tent" | "half" | "open";

export interface PostureReading {
  stateId: number | null;
  posture: Posture | null;
  rotation: 0 | 1 | 2 | 3 | null;
}

export const POSTURE_ANGLE: Record<Posture, number> = {
  closed: 0,
  tent: 30,
  half: 100,
  open: 180,
};

const STATE_TABLE_RE = /identifier=(\d+),\s*name='([^']+)'/g;

/** Parses `cmd device_state print-states` output into id -> name. */
export function parseStatesTable(text: string): Map<number, string> {
  const table = new Map<number, string>();
  for (const match of text.matchAll(STATE_TABLE_RE)) {
    table.set(Number(match[1]), match[2]);
  }
  return table;
}

/**
 * A concurrent or rear-display mode has no fixed fold angle (both panels can
 * be lit at once, or a mode the phone doesn't otherwise use for folding), so
 * it maps to null: the caller keeps whatever posture it last had.
 */
export function postureOfName(name: string): Posture | null {
  const upper = name.toUpperCase();
  if (upper.includes("CONCURRENT") || upper.includes("REAR")) return null;
  if (upper.includes("HALF")) return "half";
  if (upper.includes("TENT")) return "tent";
  if (upper.includes("CLOSED") || upper.includes("FOLDED")) return "closed";
  if (upper.includes("OPEN")) return "open";
  return null;
}

const BARE_ID_RE = /^(\d+)$/;
const DEVICE_STATE_ID_RE = /^DeviceState\{identifier=(\d+)/;
const ROTATION_RE = /\bmRotation=(\d)\b/;

function stateIdOf(lines: string[]): number | null {
  for (const line of lines) {
    const bare = BARE_ID_RE.exec(line);
    if (bare) return Number(bare[1]);
    const deviceState = DEVICE_STATE_ID_RE.exec(line);
    if (deviceState) return Number(deviceState[1]);
  }
  return null;
}

function rotationOf(lines: string[]): 0 | 1 | 2 | 3 | null {
  for (const line of lines) {
    const match = ROTATION_RE.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  }
  return null;
}

/** Parses one sampler sample (a device-state id/line plus rotation/size lines) into a reading. */
export function parseSample(lines: string[], table: Map<number, string>): PostureReading {
  const stateId = stateIdOf(lines);
  const name = stateId === null ? undefined : table.get(stateId);
  return {
    stateId,
    posture: name === undefined ? null : postureOfName(name),
    rotation: rotationOf(lines),
  };
}

export function samplesEqual(a: PostureReading, b: PostureReading): boolean {
  return a.stateId === b.stateId && a.posture === b.posture && a.rotation === b.rotation;
}
