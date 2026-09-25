export type Mode =
  | { mode: "run"; serial: string | null; replay: string | null; record: string | null; userData: string | null; dryRunTransfers: boolean }
  | { mode: "probe"; serial: string | null; seconds: number; out: string | null };

export function parseArgs(argv: string[]): Mode {
  let probe = false;
  let serial: string | null = null;
  let replay: string | null = null;
  let record: string | null = null;
  let seconds = 90;
  let out: string | null = null;
  let userData: string | null = null;
  let dryRunTransfers = false;

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
      case "--user-data":
        userData = argv[++i] ?? null;
        break;
      case "--dry-run-transfers":
        dryRunTransfers = true;
        break;
      default:
        break;
    }
  }

  if (probe) return { mode: "probe", serial, seconds, out };
  return { mode: "run", serial, replay, record, userData, dryRunTransfers };
}

/**
 * A packaged Windows build has no attached console, so a startup error (a
 * bad --seconds value, say) logged with console.error is invisible to the
 * user; route it to a dialog there instead. Anywhere else (dev, Linux) a
 * console is normally visible, so keep using it.
 */
export function reportStartupError(e: unknown, opts: { packaged: boolean; platform: NodeJS.Platform }): { channel: "dialog" | "console"; message: string } {
  const channel = opts.packaged && opts.platform === "win32" ? "dialog" : "console";
  return { channel, message: String(e) };
}
