import type { Adb } from "@yume-chan/adb";
import { TextDecoderStream } from "@yume-chan/stream-extra";
import { parseSample, parseStatesTable, samplesEqual, type PostureReading } from "../shared/posture";
import type { MediaSink } from "./media-source";
import { startSampler, stdoutOf } from "./posture-sampler";

export const STATES_MARKER = "@states ";

/** Turns raw sampler/adb text into deduped PostureReadings; knows nothing about adb or MediaSink. */
export class PostureStream {
  #table = new Map<number, string>();
  #last: PostureReading | null = null;

  constructor(private readonly onReading: (reading: PostureReading) => void) {}

  /** From `cmd device_state print-states` (`DeviceState{identifier=N, name='NAME', ...}` lines). */
  statesText(text: string): void {
    this.#table = parseStatesTable(text);
  }

  /** From a recorded `@states 0=CLOSED,1=TENT,...` line. */
  statesLine(line: string): void {
    const body = line.startsWith(STATES_MARKER) ? line.slice(STATES_MARKER.length) : line;
    const table = new Map<number, string>();
    for (const pair of body.split(",")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const id = Number(pair.slice(0, eq));
      const name = pair.slice(eq + 1);
      if (Number.isFinite(id) && name) table.set(id, name);
    }
    this.#table = table;
  }

  /** One sampler sample's raw lines. */
  sample(lines: string[]): void {
    const reading = parseSample(lines, this.#table);
    if (this.#last && samplesEqual(this.#last, reading)) return;
    this.#last = reading;
    this.onReading(reading);
  }

  /** The current table encoded as a `@states ...` line, for the recorder and for statesLine to round-trip. */
  tableLine(): string {
    const body = [...this.#table.entries()].map(([id, name]) => `${id}=${name}`).join(",");
    return `${STATES_MARKER}${body}`;
  }

  /** Forgets the last emitted reading, so the next sample() always emits even if it repeats where a previous run of this stream left off (a replay loop restarting from the top). */
  reset(): void {
    this.#last = null;
  }
}

export interface SampleHandle {
  stop(): Promise<void>;
  /** Resolves when the sample stream ends, whether from stop() or the shell exiting on its own. */
  ended: Promise<void>;
}

export type SampleStarter = (adb: Adb, onLines: (lines: string[]) => void) => Promise<SampleHandle>;
export type StatesTextReader = (adb: Adb) => Promise<string>;

const defaultStartSample: SampleStarter = (adb, onLines) => startSampler(adb, (sample) => onLines(sample.lines));

const PRINT_STATES_TIMEOUT_MS = 3000;

async function readAllText(reader: ReadableStreamDefaultReader<string>): Promise<string> {
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message} within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/** A shell that never answers is killed and its stream let go, so the adb socket behind it does not stay open for the session. */
async function defaultReadStatesText(adb: Adb): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  const spawned = shell
    ? await shell.spawn("cmd device_state print-states")
    : await adb.subprocess.noneProtocol.spawn("cmd device_state print-states");
  const reader = stdoutOf(spawned).pipeThrough(new TextDecoderStream()).getReader();
  try {
    return await withTimeout(readAllText(reader), PRINT_STATES_TIMEOUT_MS, "print-states did not respond");
  } catch (e) {
    await reader.cancel().catch(() => {});
    await Promise.resolve(spawned.kill()).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}

const SAMPLER_RESTART_DELAY_MS = 2000;

/**
 * Starts posture monitoring for a live session: reads the device-state
 * table once (best effort, bounded by a timeout; an empty table still lets
 * rotation through the sampler), then starts the sample stream and turns
 * every sample into a deduped PostureReading on sink.posture, alongside the
 * raw lines on sink.postureLine for the recorder. If the sampler fails to
 * start, or exits on its own mid-session, it is restarted once after a
 * short delay; a second failure or death gives up and leaves mirroring to
 * run on stream size alone.
 */
export async function startFoldMonitor(
  adb: Adb,
  sink: MediaSink,
  log: (line: string) => void,
  deps: { startSample?: SampleStarter; readStatesText?: StatesTextReader } = {},
): Promise<() => Promise<void>> {
  const startSample = deps.startSample ?? defaultStartSample;
  const readStatesText = deps.readStatesText ?? defaultReadStatesText;

  const stream = new PostureStream((reading) => sink.posture?.(reading));

  try {
    const text = await readStatesText(adb);
    stream.statesText(text);
    sink.postureLine?.(stream.tableLine());
  } catch (e) {
    log(`fold monitor: print-states failed: ${String(e)}`);
  }

  let stopSample: (() => Promise<void>) | null = null;
  let stopped = false;

  async function maybeRestart(attempt: number): Promise<void> {
    if (stopped || attempt > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, SAMPLER_RESTART_DELAY_MS));
    if (stopped) return;
    await run(attempt + 1);
  }

  async function run(attempt: number): Promise<void> {
    let handle: SampleHandle;
    try {
      handle = await startSample(adb, (lines) => {
        sink.postureLine?.(lines.join(" | "));
        stream.sample(lines);
      });
    } catch (e) {
      log(`fold monitor: sampler failed to start: ${String(e)}`);
      await maybeRestart(attempt);
      return;
    }
    if (stopped) {
      await handle.stop().catch(() => {});
      return;
    }
    stopSample = handle.stop;
    void handle.ended.then(() => {
      if (stopped) return;
      stopSample = null;
      log("fold monitor: sampler exited unexpectedly");
      void maybeRestart(attempt);
    });
  }

  await run(0);

  return async () => {
    stopped = true;
    await stopSample?.().catch(() => {});
  };
}
