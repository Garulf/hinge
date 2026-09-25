import type { Adb } from "@yume-chan/adb";
import { SplitStringStream, TextDecoderStream, type ReadableStream } from "@yume-chan/stream-extra";

export const SAMPLER_SCRIPT = [
  "i=0",
  "while true; do",
  '  i=$((i+1)); echo "@@hinge-tick $i"',
  "  cmd device_state print-state 2>&1",
  "  dumpsys window displays 2>/dev/null | grep -m1 -E '^ *mRotation='",
  '  echo "@@hinge-end $i"',
  "  sleep 0.25",
  "done",
].join("\n");

export interface PostureSample {
  tick: number;
  lines: string[];
}

const TICK_RE = /^@@hinge-tick (\d+)$/;
const END_RE = /^@@hinge-end (\d+)$/;

/** Collects the lines between a tick marker and the end marker with the same number, handing the sample over as soon as it ends. */
export class SampleAssembler {
  #tick: number | null = null;
  #lines: string[] = [];

  push(line: string): PostureSample | null {
    const trimmed = line.trim();
    const tick = TICK_RE.exec(trimmed);
    if (tick) {
      this.#tick = Number(tick[1]);
      this.#lines = [];
      return null;
    }
    if (this.#tick === null) return null;
    const end = END_RE.exec(trimmed);
    if (end) {
      if (Number(end[1]) !== this.#tick) return null;
      const sample = { tick: this.#tick, lines: this.#lines };
      this.#tick = null;
      this.#lines = [];
      return sample;
    }
    if (trimmed.length > 0) this.#lines.push(trimmed);
    return null;
  }
}

interface StdoutLike {
  stdout: ReadableStream<Uint8Array>;
}

/** Shared with fold-monitor.ts's one-shot `print-states` run: adb.subprocess spawn() results expose their output as either `stdout` (shellProtocol) or `output` (noneProtocol). */
export function stdoutOf(process: unknown): ReadableStream<Uint8Array> {
  if (process !== null && typeof process === "object" && "stdout" in process) {
    return (process as StdoutLike).stdout;
  }
  return (process as { output: ReadableStream<Uint8Array> }).output;
}

export interface SamplerHandle {
  stop(): Promise<void>;
  /** Resolves once the underlying shell's stdout ends, whether from stop() killing it or the shell exiting on its own (crash, adb disconnect, device reboot, ...). Lets a caller tell a deliberate stop apart from an unexpected death and react (fold-monitor.ts restarts once on an unexpected death). */
  ended: Promise<void>;
}

export async function startSampler(
  adb: Adb,
  onSample: (sample: PostureSample) => void,
): Promise<SamplerHandle> {
  const shell = adb.subprocess.shellProtocol;
  const spawned = shell ? await shell.spawn(SAMPLER_SCRIPT) : await adb.subprocess.noneProtocol.spawn(SAMPLER_SCRIPT);

  const assembler = new SampleAssembler();

  const reader = stdoutOf(spawned).pipeThrough(new TextDecoderStream()).pipeThrough(new SplitStringStream("\n")).getReader();

  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const sample = assembler.push(value);
        if (sample) onSample(sample);
      }
    } catch {
      // the process is killed on stop(); reading a torn-down stream then rejects, nothing to act on
    } finally {
      resolveEnded();
    }
  })();

  return {
    stop: async () => {
      await spawned.kill();
    },
    ended,
  };
}
