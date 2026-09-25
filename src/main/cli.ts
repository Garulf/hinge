export type Mode =
  | { mode: "run"; serial: string | null; replay: string | null; record: string | null }
  | { mode: "probe"; serial: string | null; seconds: number; out: string | null };

export function parseArgs(argv: string[]): Mode {
  let probe = false;
  let serial: string | null = null;
  let replay: string | null = null;
  let record: string | null = null;
  let seconds = 90;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--probe":
        probe = true;
        break;
      case "--serial":
        serial = argv[++i] ?? null;
        break;
      case "--replay":
        replay = argv[++i] ?? null;
        break;
      case "--record":
        record = argv[++i] ?? null;
        break;
      case "--seconds": {
        const raw = argv[++i];
        const value = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isFinite(value)) throw new Error(`--seconds requires a numeric value, got ${raw ?? "(missing)"}`);
        seconds = value;
        break;
      }
      case "--out":
        out = argv[++i] ?? null;
        break;
      default:
        break;
    }
  }

  if (probe) return { mode: "probe", serial, seconds, out };
  return { mode: "run", serial, replay, record };
}
