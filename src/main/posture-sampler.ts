import type { Adb } from "@yume-chan/adb";
import { SplitStringStream, TextDecoderStream, type ReadableStream } from "@yume-chan/stream-extra";

export const SAMPLER_SCRIPT = [
  "i=0",
  "while true; do",
  '  i=$((i+1)); echo "@@hinge-tick $i"',
  "  cmd device_state print-state 2>&1",
  "  dumpsys window displays 2>/dev/null | grep -m1 -E '^ *mRotation='",
  "  wm size 2>&1 | tail -n 1",
  "  sleep 0.25",
  "done",
].join("\n");

export interface PostureSample {
  tick: number;
  lines: string[];
}

const TICK_RE = /^@@hinge-tick (\d+)$/;

export class SampleAssembler {
  #tick: number | null = null;
  #lines: string[] = [];

  push(line: string): PostureSample | null {
    const trimmed = line.trim();
    const match = TICK_RE.exec(trimmed);
    if (match) {
      const sample = this.#tick === null ? null : { tick: this.#tick, lines: this.#lines };
      this.#tick = Number(match[1]);
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

function stdoutOf(process: unknown): ReadableStream<Uint8Array> {
  if (process !== null && typeof process === "object" && "stdout" in process) {
    return (process as StdoutLike).stdout;
  }
  return (process as { output: ReadableStream<Uint8Array> }).output;
}

export async function startSampler(
  adb: Adb,
  onSample: (sample: PostureSample, raw: string[]) => void,
): Promise<() => Promise<void>> {
  const shell = adb.subprocess.shellProtocol;
  const spawned = shell ? await shell.spawn(SAMPLER_SCRIPT) : await adb.subprocess.noneProtocol.spawn(SAMPLER_SCRIPT);

  const assembler = new SampleAssembler();
  let raw: string[] = [];

  const reader = stdoutOf(spawned).pipeThrough(new TextDecoderStream()).pipeThrough(new SplitStringStream("\n")).getReader();

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        raw.push(value);
        const sample = assembler.push(value);
        if (sample) {
          onSample(sample, raw.slice(0, -1));
          raw = [value];
        }
      }
    } catch {
      // the process is killed on stop(); reading a torn-down stream then rejects, nothing to act on
    }
  })();

  return async () => {
    await spawned.kill();
  };
}
