import type { Adb } from "@yume-chan/adb";
import { ReadableStream } from "@yume-chan/stream-extra";
import { expect, test } from "vitest";
import { SampleAssembler, SAMPLER_SCRIPT, samplerScript, startSampler } from "../../src/main/posture-sampler";

test("a sample is flushed on its own end marker, not held until the next tick", () => {
  const a = new SampleAssembler();
  expect(a.push("@@hinge-tick 1")).toBeNull();
  expect(a.push("Committed state: DeviceState{identifier=0, name='CLOSED'}")).toBeNull();
  expect(a.push("    mRotation=0 mDeferredRotationPauseCount=0")).toBeNull();
  expect(a.push("@@hinge-end 1")).toEqual({ tick: 1, lines: ["Committed state: DeviceState{identifier=0, name='CLOSED'}", "mRotation=0 mDeferredRotationPauseCount=0"] });
});

test("lines outside a tick and its end marker, and an end marker for another tick, are ignored", () => {
  const a = new SampleAssembler();
  expect(a.push("stray")).toBeNull();
  expect(a.push("@@hinge-end 7")).toBeNull();
  expect(a.push("@@hinge-tick 8")).toBeNull();
  expect(a.push("3")).toBeNull();
  expect(a.push("@@hinge-end 7")).toBeNull();
  expect(a.push("@@hinge-end 8")).toEqual({ tick: 8, lines: ["3"] });
  expect(a.push("late")).toBeNull();
  expect(a.push("@@hinge-tick 9")).toBeNull();
  expect(a.push("@@hinge-end 9")).toEqual({ tick: 9, lines: [] });
});

test("the script closes every sample with an end marker after its last command", () => {
  const lines = SAMPLER_SCRIPT.split("\n").map((l) => l.trim());
  const end = lines.findIndex((l) => l.startsWith('echo "@@hinge-end'));
  expect(end).toBeGreaterThan(lines.findIndex((l) => l.startsWith("dumpsys window displays")));
  expect(lines[end + 1]).toMatch(/^sleep /);
});

test("the sampler no longer runs wm size, which no reading uses", () => {
  expect(SAMPLER_SCRIPT).not.toMatch(/wm size/);
});

test("startSampler hands each sample over as soon as its end marker arrives", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const samples: string[][] = [];
  await startSampler(fakeShellAdb(stream), (sample) => samples.push(sample.lines));
  controller.enqueue(new TextEncoder().encode("@@hinge-tick 1\n3\nmRotation=1\n@@hinge-end 1\n"));
  await new Promise((r) => setImmediate(r));
  expect(samples).toEqual([["3", "mRotation=1"]]);
});

test("the script is one shell loop with a tick marker and a sleep", () => {
  expect(SAMPLER_SCRIPT).toMatch(/while true/);
  expect(SAMPLER_SCRIPT).toMatch(/@@hinge-tick/);
  expect(SAMPLER_SCRIPT).toMatch(/cmd device_state print-state/);
  expect(SAMPLER_SCRIPT).toMatch(/sleep 0\.25/);
});

test("samples rotation from dumpsys window displays, since SurfaceOrientation prints nothing on Android 16", () => {
  expect(SAMPLER_SCRIPT).toMatch(/dumpsys window displays/);
  expect(SAMPLER_SCRIPT).toMatch(/mRotation=/);
  expect(SAMPLER_SCRIPT).not.toMatch(/SurfaceOrientation/);
});

function fakeShellAdb(stream: ReadableStream<Uint8Array>, kill: () => Promise<void> | void = () => {}): Adb {
  return {
    subprocess: {
      shellProtocol: {
        spawn: async () => ({ stdout: stream, kill }),
      },
    },
  } as unknown as Adb;
}

test("ended resolves when the shell's stdout closes on its own, without stop() being called", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  let killed = false;
  const handle = await startSampler(fakeShellAdb(stream, () => {
    killed = true;
  }), () => {});

  let endedResolved = false;
  void handle.ended.then(() => {
    endedResolved = true;
  });

  controller.close();
  await new Promise((r) => setImmediate(r));

  expect(endedResolved).toBe(true);
  expect(killed).toBe(false);
});

test("ended resolves once stop() kills the process and its stdout closes", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const handle = await startSampler(
    fakeShellAdb(stream, () => {
      controller.close();
    }),
    () => {},
  );

  let endedResolved = false;
  void handle.ended.then(() => {
    endedResolved = true;
  });

  await handle.stop();
  await new Promise((r) => setImmediate(r));

  expect(endedResolved).toBe(true);
});

test("extra commands run inside each sample, after the posture commands and before the end marker", () => {
  const lines = samplerScript(["wm size"]).split("\n").map((l) => l.trim());
  const extra = lines.findIndex((l) => l.startsWith("wm size"));
  expect(extra).toBeGreaterThan(lines.findIndex((l) => l.startsWith("dumpsys window displays")));
  expect(lines[extra + 1]).toMatch(/^echo "@@hinge-end/);
});

test("startSampler runs the live script unless extra commands are asked for", async () => {
  const scripts: string[] = [];
  const adb = {
    subprocess: {
      shellProtocol: {
        spawn: async (script: string) => {
          scripts.push(script);
          return { stdout: new ReadableStream<Uint8Array>(), kill: () => {} };
        },
      },
    },
  } as unknown as Adb;
  await startSampler(adb, () => {});
  await startSampler(adb, () => {}, { extraCommands: ["wm size"] });
  expect(scripts[0]).toBe(SAMPLER_SCRIPT);
  expect(scripts[1]).toMatch(/wm size/);
});
