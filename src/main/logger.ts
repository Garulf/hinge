import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  readonly path: string;
  log(line: string): void;
}

/** Truncates the file at startup so each run gets its own log, with no rotation to manage. */
export function createLogger(path: string): Logger {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch {
    // a log directory that cannot be created or written to must not crash the app
  }
  return {
    path,
    log(line: string): void {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // logging must never crash the app
      }
    },
  };
}
