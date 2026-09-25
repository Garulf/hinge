import type { Adb } from "@yume-chan/adb";
import { ReadableStream } from "@yume-chan/stream-extra";
import { expect, test } from "vitest";
import { SampleAssembler, SAMPLER_SCRIPT, startSampler } from "../../src/main/posture-sampler";

test("groups lines between tick markers into samples", () => {
  const a = new SampleAssembler();
  expect(a.push("@@hinge-tick 1")).toBeNull();
  expect(a.push("Committed state: DeviceState{identifier=0, name='CLOSED'}")).toBeNull();
  expect(a.push("    mRotation=0 mDeferredRotationPauseCount=0")).toBeNull();
  expect(a.push("@@hinge-tick 2")).toEqual({ tick: 1, lines: ["Committed state: DeviceState{identifier=0, name='CLOSED'}", "mRotation=0 mDeferredRotationPauseCount=0"] });
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
