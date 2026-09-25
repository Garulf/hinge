import { expect, test } from "vitest";
import { createClipboardSync, type ClipboardHost } from "../../src/main/clipboard-sync";

interface FakeHost {
  host: ClipboardHost;
  written: string[];
  current(): string;
  setCurrent(v: string): void;
}

function fakeHost(initial = ""): FakeHost {
  let current = initial;
  const written: string[] = [];
  const host: ClipboardHost = {
    readText: async () => current,
    writeText: async (t) => {
      written.push(t);
      current = t;
    },
  };
  return { host, written, current: () => current, setCurrent: (v) => { current = v; } };
}

function fakeStream(): { stream: ReadableStream<string>; push: (v: string) => void; close: () => void } {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({ start: (c) => { controller = c; } });
  return { stream, push: (v) => controller.enqueue(v), close: () => controller.close() };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a device clipboard change different from the current PC clipboard is written to it", async () => {
  const { host, written } = fakeHost("");
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();
  push("copied on the phone");
  close();
  await done;
  expect(written).toEqual(["copied on the phone"]);
});

test("a device value that already equals the current PC clipboard is never written (the echo check)", async () => {
  const { host, written } = fakeHost("already this");
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();
  push("already this");
  close();
  await done;
  expect(written).toEqual([]);
});

test("scrcpy-style echo check by exact reported sequence: paste foo to phone, copy bar on the PC, copy foo on the phone again -> PC ends up with foo", async () => {
  // The PC clipboard already holds "foo" (what we just pushed to the phone via setClipboard).
  const { host, written, setCurrent, current } = fakeHost("foo");
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();

  push("foo"); // the device echoing back exactly what was just set: matches, skipped
  setCurrent("bar"); // the user copies "bar" on the PC, outside this app entirely
  push("foo"); // a genuine new copy of "foo" on the device, now different from the PC's current "bar"
  close();
  await done;

  expect(written).toEqual(["foo"]);
  expect(current()).toBe("foo");
});

test("beginPush still hands out increasing sequence numbers for the setClipboard control message", () => {
  const { host } = fakeHost();
  const sync = createClipboardSync({ stream: undefined, host });
  expect(sync.beginPush("a")).toBe(1n);
  expect(sync.beginPush("b")).toBe(2n);
  expect(sync.beginPush("c")).toBe(3n);
});

test("no unbounded state: many pushes of the same content never make a later genuine device copy of it get swallowed", async () => {
  const { host, written, setCurrent } = fakeHost("x");
  const { stream, push, close } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();

  // Ten pushes of "x" in a row (as if the user pasted the same thing to the
  // phone repeatedly); none of these leave any trace for later.
  for (let i = 0; i < 10; i++) sync.beginPush("x");

  setCurrent("something else"); // the PC clipboard moved on
  push("x"); // the device now genuinely has "x" again, distinct from history
  close();
  await done;

  expect(written).toEqual(["x"]);
});

test("start() with no stream resolves immediately instead of hanging", async () => {
  const { host } = fakeHost();
  const sync = createClipboardSync({ stream: undefined, host });
  await expect(sync.start()).resolves.toBeUndefined();
});

test("stop() cancels the drain so start() resolves without reading further", async () => {
  const { host, written } = fakeHost("");
  const { stream, push } = fakeStream();
  const sync = createClipboardSync({ stream, host });
  const done = sync.start();
  push("one");
  await flush();
  sync.stop();
  await done;
  expect(written).toEqual(["one"]);
});

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

test("a readText() failure is logged and treated as an empty current clipboard, not a crash", async () => {
  const { stream, push, close } = fakeStream();
  const logs: string[] = [];
  const written: string[] = [];
  const host: ClipboardHost = {
    readText: async () => {
      throw new Error("clipboard locked");
    },
    writeText: async (t) => {
      written.push(t);
    },
  };
  const sync = createClipboardSync({ stream, host, log: (l) => logs.push(l) });
  const done = sync.start();
  push("phone value");
  close();
  await done;
  expect(logs.some((l) => l.includes("clipboard locked"))).toBe(true);
  expect(written).toEqual(["phone value"]);
});
