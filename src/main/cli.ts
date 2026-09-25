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
      case "--seconds":
        seconds = Number(argv[++i]);
        break;
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
