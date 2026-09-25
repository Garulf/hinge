import { expect, test } from "vitest";
import { createClipboardSync, type ClipboardHost } from "../../src/main/clipboard-sync";

function fakeHost(): { host: ClipboardHost; written: string[] } {
  const written: string[] = [];
  return { host: { writeText: async (t) => { written.push(t); }, readText: async () => "" }, written };
}

function fakeStream(): { stream: ReadableStream<string>; push: (v: string) => void; close: () => void } {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({ start: (c) => { controller = c; } });
  return { stream, push: (v) => controller.enqueue(v), close: () => controller.close() };
}

test("a device clipboard change is written to the PC clipboard", async () => {
  const { host, written } = fakeHost();
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();
  push("copied on the phone");
  close();
  await done;
  expect(written).toEqual(["copied on the phone"]);
});

test("a PC-to-device push's echo is suppressed once and does not bounce back to the PC clipboard, breaking the loop", async () => {
  const { host, written } = fakeHost();
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();

  const sequence = sync.beginPush("pushed from pc");
  expect(sequence).toBe(1n);
  push("pushed from pc"); // the device echoing back exactly what we set
  push("a later real device change"); // this one must still propagate
  close();
  await done;

  expect(written).toEqual(["a later real device change"]);
});

test("sequence numbers increment on every push, and two pushes in flight before either echo arrives are each independently suppressed", async () => {
  const { host, written } = fakeHost();
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();

  expect(sync.beginPush("first")).toBe(1n);
  expect(sync.beginPush("second")).toBe(2n);
  push("first");
  push("second");
  push("a genuine device change");
  close();
  await done;

  expect(written).toEqual(["a genuine device change"]);
});

test("a device change that does not match the pending push clears the pending flag and is written, not swallowed", async () => {
  const { host, written } = fakeHost();
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();

  sync.beginPush("expected echo");
  push("something else entirely");
  close();
  await done;

  expect(written).toEqual(["something else entirely"]);
});

test("start() with no stream resolves immediately instead of hanging", async () => {
  const { host } = fakeHost();
  const sync = createClipboardSync({ stream: undefined, host });
  await expect(sync.start()).resolves.toBeUndefined();
});

test("stop() cancels the drain so start() resolves without reading further", async () => {
  const { host, written } = fakeHost();
  const { stream, push } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();
  push("one");
  await flush();
  sync.stop();
  await done;
  expect(written).toEqual(["one"]);
});

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a write failure is logged, not thrown, and draining continues", async () => {
  const { stream, push, close } = fakeStream();
  const logs: string[] = [];
  const written: string[] = [];
  const host: ClipboardHost = {
    readText: async () => "",
    writeText: async (t) => {
      if (t === "boom") throw new Error("clipboard busy");
      written.push(t);
    },
  };
  const sync = createClipboardSync({ stream, host, log: (l) => logs.push(l) });
  const done = sync.start();
  push("boom");
  push("ok-after");
  close();
  await done;
  expect(logs.some((l) => l.includes("clipboard busy"))).toBe(true);
  expect(written).toEqual(["ok-after"]);
});
