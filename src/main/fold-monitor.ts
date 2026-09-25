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
}

export type SampleStarter = (adb: Adb, onLines: (lines: string[]) => void) => Promise<() => Promise<void>>;
export type StatesTextReader = (adb: Adb) => Promise<string>;

const defaultStartSample: SampleStarter = (adb, onLines) => startSampler(adb, (sample) => onLines(sample.lines));

async function defaultReadStatesText(adb: Adb): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  const spawned = shell
    ? await shell.spawn("cmd device_state print-states")
    : await adb.subprocess.noneProtocol.spawn("cmd device_state print-states");
  const reader = stdoutOf(spawned).pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

const SAMPLER_RESTART_DELAY_MS = 2000;

/**
 * Starts posture monitoring for a live session: reads the device-state
 * table once (best effort; an empty table still lets rotation through the
 * sampler), then starts the sample stream and turns every sample into a
 * deduped PostureReading on sink.posture, alongside the raw lines on
 * sink.postureLine for the recorder. If the sampler fails to start, it is
 * restarted once after a short delay; a second failure gives up and leaves
 * mirroring to run on stream size alone.
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

  async function run(attempt: number): Promise<void> {
    try {
      stopSample = await startSample(adb, (lines) => {
        sink.postureLine?.(lines.join(" | "));
        stream.sample(lines);
      });
    } catch (e) {
      log(`fold monitor: sampler failed to start: ${String(e)}`);
      if (stopped || attempt > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, SAMPLER_RESTART_DELAY_MS));
      if (stopped) return;
      await run(attempt + 1);
    }
  }

  await run(0);

  return async () => {
    stopped = true;
    await stopSample?.().catch(() => {});
  };
}
