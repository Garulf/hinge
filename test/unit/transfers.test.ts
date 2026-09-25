import { expect, test } from "vitest";
import { createTransferQueue, type LocalFile, type TransferDeps, type TransferProgress } from "../../src/main/transfers";

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

interface FakeDeps {
  deps: TransferDeps;
  files: Record<string, LocalFile>;
  installs: Uint8Array[];
  pushes: { path: string; data: Uint8Array }[];
  scans: string[];
  removes: string[];
}

function fakeDeps(): FakeDeps {
  const files: Record<string, LocalFile> = {};
  const installs: Uint8Array[] = [];
  const pushes: { path: string; data: Uint8Array }[] = [];
  const scans: string[] = [];
  const removes: string[] = [];
  const deps: TransferDeps = {
    openFile: async (path) => {
      const f = files[path];
      if (!f) throw new Error(`no such file: ${path}`);
      return f;
    },
    installApk: async (stream) => {
      installs.push(await readAll(stream));
    },
    pushFile: async (path, stream) => {
      pushes.push({ path, data: await readAll(stream) });
    },
    scanFile: async (path) => {
      scans.push(path);
    },
    removeFile: async (path) => {
      removes.push(path);
    },
  };
  return { deps, files, installs, pushes, scans, removes };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function collect(): { progress: TransferProgress[]; off: () => void } {
  const progress: TransferProgress[] = [];
  return { progress, off: () => {} };
}

test("a .apk file installs via installApk, not pushFile", async () => {
  const { deps, files, installs, pushes } = fakeDeps();
  files["/tmp/app.apk"] = { size: 5, stream: textStream("hello") };
  const queue = createTransferQueue(deps);
  const { progress } = collect();
  queue.onProgress((p) => progress.push(p));

  queue.enqueue(["/tmp/app.apk"]);
  await flush();
  await flush();

  expect(installs).toHaveLength(1);
  expect(new TextDecoder().decode(installs[0])).toBe("hello");
  expect(pushes).toEqual([]);
  expect(progress.map((p) => p.state)).toEqual(["queued", "running", "running", "done"]);
  expect(progress.every((p) => p.kind === "install")).toBe(true);
});

test("a non-apk file pushes to /sdcard/Download/<name> and then scans it", async () => {
  const { deps, files, pushes, scans } = fakeDeps();
  files["/tmp/photo.png"] = { size: 4, stream: textStream("data") };
  const queue = createTransferQueue(deps);
  queue.enqueue(["/tmp/photo.png"]);
  await flush();
  await flush();

  expect(pushes).toHaveLength(1);
  expect(pushes[0].path).toBe("/sdcard/Download/photo.png");
  expect(new TextDecoder().decode(pushes[0].data)).toBe("data");
  expect(scans).toEqual(["/sdcard/Download/photo.png"]);
});

test("names with spaces and non-ASCII characters land unchanged", async () => {
  const { deps, files, pushes } = fakeDeps();
  const name = "my résumé (final) 简历.pdf";
  files[`/home/user/${name}`] = { size: 3, stream: textStream("pdf") };
  const queue = createTransferQueue(deps);
  queue.enqueue([`/home/user/${name}`]);
  await flush();
  await flush();

  expect(pushes[0].path).toBe(`/sdcard/Download/${name}`);
});

test("a Windows-style path's backslash separators are handled for the device file name", async () => {
  const { deps, files, pushes } = fakeDeps();
  files["C:\\Users\\test\\my file.txt"] = { size: 1, stream: textStream("x") };
  const queue = createTransferQueue(deps);
  queue.enqueue(["C:\\Users\\test\\my file.txt"]);
  await flush();
  await flush();

  expect(pushes[0].path).toBe("/sdcard/Download/my file.txt");
});

test("multiple files run one at a time, in order, not concurrently", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  let resolveFirst!: () => void;
  const gate = new Promise<void>((r) => { resolveFirst = r; });
  const deps: TransferDeps = {
    openFile: async (path) => ({ size: 1, stream: textStream("x") }),
    installApk: async () => {},
    pushFile: async (path) => {
      started.push(path);
      if (path.endsWith("a.txt")) await gate;
      finished.push(path);
    },
    scanFile: async () => {},
    removeFile: async () => {},
  };
  const queue = createTransferQueue(deps);
  queue.enqueue(["/tmp/a.txt", "/tmp/b.txt"]);
  await flush();

  expect(started).toEqual(["/sdcard/Download/a.txt"]);
  expect(finished).toEqual([]);

  resolveFirst();
  await flush();
  await flush();

  expect(started).toEqual(["/sdcard/Download/a.txt", "/sdcard/Download/b.txt"]);
  expect(finished).toEqual(["/sdcard/Download/a.txt", "/sdcard/Download/b.txt"]);
});

test("cancelAll mid-transfer marks the running item cancelled, not done, and drops the rest of the queue without starting them", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const slowStream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
      c.enqueue(new TextEncoder().encode("first-chunk"));
    },
  });
  const deps: TransferDeps = {
    openFile: async (path) => (path === "/tmp/slow.bin" ? { size: 100, stream: slowStream } : { size: 1, stream: textStream("x") }),
    installApk: async () => {},
    pushFile: async (_path, stream) => {
      await readAll(stream); // blocks until the stream ends or errors
    },
    scanFile: async () => {},
    removeFile: async () => {},
  };
  const queue = createTransferQueue(deps);
  const progress: TransferProgress[] = [];
  queue.onProgress((p) => progress.push(p));

  queue.enqueue(["/tmp/slow.bin", "/tmp/never-started.txt"]);
  await flush();

  queue.cancelAll();
  controller.error(new Error("aborted"));
  await flush();
  await flush();

  const byName = (name: string) => progress.filter((p) => p.name === name).map((p) => p.state);
  expect(byName("slow.bin")).toContain("cancelled");
  expect(byName("slow.bin")).not.toContain("done");
  expect(byName("never-started.txt")).toEqual(["queued", "cancelled"]);
});

test("cancelAll() itself (not the source ending) stops a real in-flight write: the stream Tango is reading errors out, and a partially-written push is best-effort removed", async () => {
  const neverEndingStream = new ReadableStream<Uint8Array>({
    start: () => {
      // never enqueues, never closes: the only way pushFile's read ever settles is via our own cancellation
    },
  });
  const removes: string[] = [];
  const deps: TransferDeps = {
    openFile: async () => ({ size: 1000, stream: neverEndingStream }),
    installApk: async () => {},
    pushFile: async (_path, stream) => {
      await readAll(stream);
    },
    scanFile: async () => {},
    removeFile: async (path) => {
      removes.push(path);
    },
  };
  const queue = createTransferQueue(deps);
  const progress: TransferProgress[] = [];
  queue.onProgress((p) => progress.push(p));

  queue.enqueue(["/tmp/huge.bin"]);
  await flush();
  expect(progress.map((p) => p.state)).toEqual(["queued", "running"]);

  queue.cancelAll();
  await flush();
  await flush();

  expect(progress.map((p) => p.state)).toEqual(["queued", "running", "cancelled"]);
  expect(removes).toEqual(["/sdcard/Download/huge.bin"]);
});

test("cancelling an install (not a push) does not attempt to remove a device file, since installApk never wrote one", async () => {
  const neverEndingStream = new ReadableStream<Uint8Array>({ start: () => {} });
  const removes: string[] = [];
  const deps: TransferDeps = {
    openFile: async () => ({ size: 1000, stream: neverEndingStream }),
    installApk: async (stream) => {
      await readAll(stream);
    },
    pushFile: async () => {},
    scanFile: async () => {},
    removeFile: async (path) => {
      removes.push(path);
    },
  };
  const queue = createTransferQueue(deps);
  const progress: TransferProgress[] = [];
  queue.onProgress((p) => progress.push(p));

  queue.enqueue(["/tmp/app.apk"]);
  await flush();
  queue.cancelAll();
  await flush();
  await flush();

  expect(progress.map((p) => p.state)).toEqual(["queued", "running", "cancelled"]);
  expect(removes).toEqual([]);
});

test("an enqueue() after cancelAll() is ignored: a switched-away queue never starts new work", async () => {
  const { deps, files, pushes } = fakeDeps();
  files["/tmp/late.txt"] = { size: 1, stream: textStream("x") };
  const queue = createTransferQueue(deps);
  queue.cancelAll();
  queue.enqueue(["/tmp/late.txt"]);
  await flush();

  expect(pushes).toEqual([]);
});

test("a file that fails to open reports an error and does not block the rest of the queue", async () => {
  const { deps, files, pushes } = fakeDeps();
  files["/tmp/ok.txt"] = { size: 1, stream: textStream("x") };
  const queue = createTransferQueue(deps);
  const progress: TransferProgress[] = [];
  queue.onProgress((p) => progress.push(p));

  queue.enqueue(["/tmp/missing.txt", "/tmp/ok.txt"]);
  await flush();
  await flush();

  expect(progress.filter((p) => p.name === "missing.txt").map((p) => p.state)).toEqual(["queued", "error"]);
  expect(pushes).toHaveLength(1);
  expect(pushes[0].path).toBe("/sdcard/Download/ok.txt");
});
