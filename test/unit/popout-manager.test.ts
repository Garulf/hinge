import { afterEach, expect, test, vi } from "vitest";
import type { ConnectedPhone, PortLike } from "../../src/main/app-controller";
import type { MediaSink } from "../../src/main/media-source";
import {
  PopoutManager,
  type AppIdentity,
  type PopoutManagerDeps,
  type PopoutSessionLike,
  type PopoutWindow,
  type Rect,
} from "../../src/main/popout-manager";
import type { DisplayGeometry } from "../../src/shared/popout";
import type { SessionStatus } from "../../src/shared/wire";

afterEach(() => {
  vi.useRealTimers();
});

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const TITLE_BAR = 30;

class FakeWindow implements PopoutWindow {
  readonly port: PortLike = { postMessage: () => {}, onMessage: () => {} };
  focusCalls = 0;
  closeCalls = 0;
  titles: string[] = [];
  icons: Uint8Array[] = [];
  #onClosed: (() => void)[] = [];
  #onBoundsChanged: (() => void)[] = [];
  #bounds: Rect;

  constructor(
    readonly created: { pkg: string; title: string; bounds: Rect | null; content: { width: number; height: number } },
    private readonly scale = 1,
  ) {
    this.#bounds = created.bounds ?? { x: 10, y: 20 - TITLE_BAR, width: created.content.width, height: created.content.height + TITLE_BAR };
  }

  focus(): void {
    this.focusCalls++;
  }

  close(): void {
    this.closeCalls++;
    this.#fireClosed();
  }

  setTitle(title: string): void {
    this.titles.push(title);
  }

  setIcon(png: Uint8Array): void {
    this.icons.push(png);
  }

  contentBounds(): Rect {
    const b = this.#bounds;
    return { x: b.x, y: b.y + TITLE_BAR, width: b.width, height: b.height - TITLE_BAR };
  }

  windowBounds(): Rect {
    return this.#bounds;
  }

  onBoundsChanged(cb: () => void): void {
    this.#onBoundsChanged.push(cb);
  }

  userMove(bounds: Rect): void {
    this.#bounds = bounds;
    for (const cb of this.#onBoundsChanged) cb();
  }

  scaleFactor(): number {
    return this.scale;
  }

  onClosed(cb: () => void): void {
    this.#onClosed.push(cb);
  }

  userClose(): void {
    this.#fireClosed();
  }

  #fireClosed(): void {
    for (const cb of this.#onClosed) cb();
  }
}

class FakeSession implements PopoutSessionLike {
  startCalls = 0;
  stopCalls = 0;
  resizes: DisplayGeometry[] = [];
  sink: MediaSink | null = null;
  #finishStart!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.#finishStart = resolve;
  });

  constructor(
    readonly phone: ConnectedPhone,
    readonly pkg: string,
    readonly geometry: DisplayGeometry,
  ) {}

  start(sink: MediaSink): Promise<void> {
    this.sink = sink;
    this.startCalls++;
    return this.started;
  }

  finishStart(): void {
    this.#finishStart();
  }

  frame(): void {
    this.sink?.videoPacket({ type: "data", keyframe: true, pts: 0, data: new Uint8Array([0]) });
  }

  readonly #appStartedListeners: (() => void)[] = [];

  onAppStarted(cb: () => void): void {
    this.#appStartedListeners.push(cb);
  }

  appStarted(): void {
    for (const cb of this.#appStartedListeners) cb();
  }

  control(): void {}

  async stop(): Promise<void> {
    this.stopCalls++;
  }

  resize(g: DisplayGeometry): void {
    this.resizes.push(g);
  }
}

interface Binding {
  port: PortLike;
  handlers: { viewport(w: number, h: number, dpr: number): void; retry(): void };
  statuses: SessionStatus[];
}

const SINK: MediaSink = { videoStart: () => {}, videoPacket: () => {}, videoEnd: () => {}, status: () => {} };

function harness(
  opts: { savedBounds?: Rect | null; identify?: (pkg: string) => Promise<AppIdentity>; checkRefused?: (phone: ConnectedPhone, pkg: string) => Promise<boolean> } = {},
) {
  const windows: FakeWindow[] = [];
  const sessions: FakeSession[] = [];
  const bindings: Binding[] = [];
  const notices: string[] = [];
  const saved: [string, string, Rect][] = [];
  const logs: string[] = [];
  const refusalChecks: string[] = [];
  const deps: PopoutManagerDeps = {
    createWindow: (o) => {
      const w = new FakeWindow(o);
      windows.push(w);
      return w;
    },
    createSession: (phone, pkg, g) => {
      const s = new FakeSession(phone, pkg, g);
      sessions.push(s);
      return s;
    },
    bindPort: (session, port, handlers) => {
      const binding: Binding = { port, handlers, statuses: [] };
      bindings.push(binding);
      void session.start(SINK);
      return { status: (s) => binding.statuses.push(s) };
    },
    identify: (_phone, pkg) => (opts.identify ? opts.identify(pkg) : new Promise<AppIdentity>(() => {})),
    workArea: () => ({ width: 1920, height: 1040 }),
    savedBounds: () => opts.savedBounds ?? null,
    saveBounds: (deviceId, pkg, r) => saved.push([deviceId, pkg, r]),
    notice: (text) => notices.push(text),
    log: (line) => logs.push(line),
    checkRefused: (phone, pkg) => {
      refusalChecks.push(pkg);
      return opts.checkRefused ? opts.checkRefused(phone, pkg) : Promise.resolve(false);
    },
  };
  const manager = new PopoutManager(deps);
  const counts: number[] = [];
  manager.onCountChanged((n) => counts.push(n));
  return { manager, windows, sessions, bindings, notices, saved, counts, logs, refusalChecks };
}

function fold(deviceId = "R5CY", tag = "a"): ConnectedPhone {
  return { adb: { tag } as never, serial: `${deviceId}-serial`, deviceId, model: "SM-F966B" };
}

test("open creates one window titled with the package and starts one session sized to it, then takes the app's label and icon", async () => {
  const icon = new Uint8Array([1, 2, 3]);
  const { manager, windows, sessions } = harness({ identify: async () => ({ label: "Example", icon }) });
  manager.setPhone(fold());

  expect(manager.open("com.example.app")).toBe("opened");
  expect(windows).toHaveLength(1);
  expect(windows[0].created).toEqual({ pkg: "com.example.app", title: "com.example.app", bounds: null, content: { width: 379, height: 884 } });
  expect(sessions).toHaveLength(1);
  expect(sessions[0].pkg).toBe("com.example.app");
  expect(sessions[0].geometry).toEqual({ width: 376, height: 880, dpi: 160 });
  expect(sessions[0].startCalls).toBe(1);
  expect(manager.count()).toBe(1);

  await flush();
  expect(windows[0].titles).toEqual(["Example"]);
  expect(windows[0].icons).toEqual([icon]);
});

test("saved window bounds place the window, and its display is sized to the content inside the frame", () => {
  const { manager, windows, sessions } = harness({ savedBounds: { x: 5, y: 6, width: 400, height: 890 } });
  manager.setPhone(fold());
  manager.open("com.example.app");

  expect(windows[0].created.bounds).toEqual({ x: 5, y: 6, width: 400, height: 890 });
  expect(sessions[0].geometry).toEqual({ width: 400, height: 856, dpi: 160 });
});

test("opening the same app again before anything resolves focuses its window", () => {
  const { manager, windows, sessions } = harness();
  manager.setPhone(fold());
  manager.open("com.example.app");

  expect(manager.open("com.example.app")).toBe("focused");
  expect(windows).toHaveLength(1);
  expect(sessions).toHaveLength(1);
  expect(windows[0].focusCalls).toBe(1);
});

test("a fifth app is refused with a notice", () => {
  const { manager, windows, notices } = harness();
  manager.setPhone(fold());
  for (const pkg of ["a.one", "a.two", "a.three", "a.four"]) expect(manager.open(pkg)).toBe("opened");

  expect(manager.open("a.five")).toBe("limit");
  expect(notices).toEqual(["Up to 4 apps can be open at once"]);
  expect(windows).toHaveLength(4);
});

test("closing a window while its session is still starting stops that session and drops the window for good", async () => {
  const { manager, windows, sessions, saved, counts } = harness();
  manager.setPhone(fold());
  manager.open("com.example.app");

  windows[0].userClose();
  expect(windows[0].closeCalls).toBe(0);
  expect(sessions[0].stopCalls).toBe(1);
  expect(manager.count()).toBe(0);
  expect(counts).toEqual([1, 0]);
  expect(saved).toEqual([["R5CY", "com.example.app", { x: 10, y: -10, width: 379, height: 914 }]]);

  sessions[0].finishStart();
  await flush();
  expect(windows).toHaveLength(1);
  expect(sessions).toHaveLength(1);
  expect(manager.count()).toBe(0);
});

test("viewport changes resize the display once they settle, and a viewport matching the display never resizes it", () => {
  vi.useFakeTimers();
  const { manager, sessions, bindings } = harness();
  manager.setPhone(fold());
  manager.open("com.example.app");
  const { viewport } = bindings[0].handlers;

  viewport(379, 884, 1);
  vi.advanceTimersByTime(500);
  expect(sessions[0].resizes).toEqual([]);

  viewport(400, 860, 1);
  vi.advanceTimersByTime(100);
  viewport(480, 860, 1);
  vi.advanceTimersByTime(149);
  expect(sessions[0].resizes).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(sessions[0].resizes).toEqual([{ width: 480, height: 856, dpi: 160 }]);
});

test("a zero-sized viewport (a minimised window) never resizes the display", () => {
  vi.useFakeTimers();
  const { manager, sessions, bindings } = harness();
  manager.setPhone(fold());
  manager.open("com.example.app");

  bindings[0].handlers.viewport(0, 0, 1);
  vi.advanceTimersByTime(500);
  expect(sessions[0].resizes).toEqual([]);
});

test("with no phone an app is queued, then opened once a phone connects", () => {
  const { manager, windows, sessions } = harness();

  expect(manager.open("com.example.app")).toBe("queued");
  expect(windows).toHaveLength(0);
  expect(manager.open("com.example.app")).toBe("queued");

  manager.setPhone(fold());
  expect(windows).toHaveLength(1);
  expect(sessions).toHaveLength(1);
});

test("losing the phone keeps the windows and shows them reconnecting; the same phone coming back restarts each session once", () => {
  vi.useFakeTimers();
  const { manager, windows, sessions, bindings } = harness();
  const first = fold("R5CY", "a");
  manager.setPhone(first);
  manager.open("a.one");
  manager.open("a.two");
  bindings[1].handlers.viewport(480, 860, 1);
  vi.advanceTimersByTime(150);

  manager.setPhone(null);
  expect(sessions.map((s) => s.stopCalls)).toEqual([1, 1]);
  expect(bindings.map((b) => b.statuses)).toEqual([
    [{ state: "connecting", serial: "R5CY-serial" }],
    [{ state: "connecting", serial: "R5CY-serial" }],
  ]);
  expect(windows.map((w) => w.closeCalls)).toEqual([0, 0]);
  expect(manager.count()).toBe(2);

  const back = fold("R5CY", "b");
  manager.setPhone(back);
  expect(sessions).toHaveLength(4);
  expect(sessions.slice(2).map((s) => [s.pkg, s.phone, s.geometry, s.startCalls])).toEqual([
    ["a.one", back, { width: 376, height: 880, dpi: 160 }, 1],
    ["a.two", back, { width: 480, height: 856, dpi: 160 }, 1],
  ]);
  expect(bindings).toHaveLength(2);
});

test("the same phone announced again with a new transport replaces each session without waiting for a disconnect", () => {
  const { manager, sessions } = harness();
  manager.setPhone(fold("R5CY", "a"));
  manager.open("a.one");

  manager.setPhone(fold("R5CY", "b"));
  expect(sessions).toHaveLength(2);
  expect(sessions[0].stopCalls).toBe(1);
  expect(sessions[1].startCalls).toBe(1);
});

test("a different phone closes every window", () => {
  const { manager, windows, sessions, counts } = harness();
  manager.setPhone(fold("R5CY"));
  manager.open("a.one");
  manager.open("a.two");
  manager.setPhone(null);

  manager.setPhone(fold("OTHER"));
  expect(windows.map((w) => w.closeCalls)).toEqual([1, 1]);
  expect(sessions).toHaveLength(2);
  expect(manager.count()).toBe(0);
  expect(counts.at(-1)).toBe(0);
});

test("retry from a window restarts only that window's session", () => {
  const { manager, sessions, bindings } = harness();
  manager.setPhone(fold());
  manager.open("a.one");
  manager.open("a.two");

  bindings[1].handlers.retry();
  expect(sessions).toHaveLength(3);
  expect(sessions.map((s) => s.stopCalls)).toEqual([0, 1, 0]);
  expect(sessions[2].pkg).toBe("a.two");
  expect(sessions[2].startCalls).toBe(1);
});

test("closeAll stops every session and closes every window", async () => {
  const { manager, windows, sessions, counts } = harness();
  manager.setPhone(fold());
  manager.open("a.one");
  manager.open("a.two");

  await manager.closeAll();
  expect(sessions.map((s) => s.stopCalls)).toEqual([1, 1]);
  expect(windows.map((w) => w.closeCalls)).toEqual([1, 1]);
  expect(manager.count()).toBe(0);
  expect(counts.at(-1)).toBe(0);
});

async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await run();
    await flush();
    await flush();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

test("a window whose bounds cannot be read on close still has its session stopped, and the failure is only logged", async () => {
  const { manager, windows, sessions, counts, logs } = harness();
  manager.setPhone(fold());
  manager.open("a.one");
  manager.open("a.two");
  for (const w of windows) {
    w.windowBounds = () => {
      throw new Error("Object has been destroyed");
    };
  }

  const rejections = await unhandledRejectionsDuring(async () => {
    windows[0].userClose();
    manager.setPhone(fold("OTHER"));
  });

  expect(rejections).toEqual([]);
  expect(sessions.map((s) => s.stopCalls)).toEqual([1, 1]);
  expect(windows[1].closeCalls).toBe(1);
  expect(manager.count()).toBe(0);
  expect(counts.at(-1)).toBe(0);
  expect(logs.filter((l) => l.includes("Object has been destroyed"))).toHaveLength(2);
});

test("closeAll closes every window even when one of them fails to close", async () => {
  const { manager, windows, sessions, logs } = harness();
  manager.setPhone(fold());
  manager.open("a.one");
  manager.open("a.two");
  windows[0].close = () => {
    throw new Error("close failed");
  };

  await manager.closeAll();
  expect(sessions.map((s) => s.stopCalls)).toEqual([1, 1]);
  expect(windows[1].closeCalls).toBe(1);
  expect(manager.count()).toBe(0);
  expect(logs.some((l) => l.includes("close failed"))).toBe(true);
});

test("a pop-out with no frame 5 s after its app was started, whose app stayed on the phone screen, closes with a notice", async () => {
  vi.useFakeTimers();
  const { manager, windows, sessions, notices, refusalChecks } = harness({
    identify: async () => ({ label: "Example", icon: null }),
    checkRefused: async () => true,
  });
  manager.setPhone(fold());
  manager.open("com.example.app");
  sessions[0].appStarted();
  await vi.advanceTimersByTimeAsync(4999);
  expect(refusalChecks).toEqual([]);

  await vi.advanceTimersByTimeAsync(1);
  expect(refusalChecks).toEqual(["com.example.app"]);
  expect(windows[0].closeCalls).toBe(1);
  expect(sessions[0].stopCalls).toBe(1);
  expect(manager.count()).toBe(0);
  expect(notices).toEqual(["Example can't run in its own window"]);
});

test("a pop-out that streamed before 5 s is never checked for refusal", async () => {
  vi.useFakeTimers();
  const { manager, windows, sessions, refusalChecks } = harness({ checkRefused: async () => true });
  manager.setPhone(fold());
  manager.open("com.example.app");
  sessions[0].appStarted();
  sessions[0].frame();

  await vi.advanceTimersByTimeAsync(5000);
  expect(refusalChecks).toEqual([]);
  expect(windows[0].closeCalls).toBe(0);
  expect(manager.count()).toBe(1);
});

test("a slow pop-out whose app is not on the phone screen stays open, and a failed check only logs", async () => {
  vi.useFakeTimers();
  const { manager, windows, sessions, notices, logs } = harness({
    checkRefused: async (_phone, pkg) => {
      if (pkg === "a.broken") throw new Error("dumpsys timed out");
      return false;
    },
  });
  manager.setPhone(fold());
  manager.open("a.slow");
  manager.open("a.broken");
  for (const session of sessions) session.appStarted();

  await vi.advanceTimersByTimeAsync(5000);
  expect(windows.map((w) => w.closeCalls)).toEqual([0, 0]);
  expect(manager.count()).toBe(2);
  expect(notices).toEqual([]);
  expect(logs.some((l) => l.includes("dumpsys timed out"))).toBe(true);
});

test("a pop-out closed or streaming by the time the refusal check answers is left alone", async () => {
  vi.useFakeTimers();
  let answer!: (refused: boolean) => void;
  const { manager, windows, sessions, notices } = harness({ checkRefused: () => new Promise((resolve) => (answer = resolve)) });
  manager.setPhone(fold());
  manager.open("com.example.app");
  sessions[0].appStarted();
  await vi.advanceTimersByTimeAsync(5000);
  sessions[0].frame();
  answer(true);
  await vi.advanceTimersByTimeAsync(1);

  expect(windows[0].closeCalls).toBe(0);
  expect(notices).toEqual([]);
});

test("the refusal check is not run once the window has closed or the phone is gone", async () => {
  vi.useFakeTimers();
  const { manager, windows, sessions, refusalChecks } = harness({ checkRefused: async () => true });
  manager.setPhone(fold());
  manager.open("a.one");
  manager.open("a.two");
  for (const session of sessions) session.appStarted();
  windows[0].userClose();
  manager.setPhone(null);

  await vi.advanceTimersByTimeAsync(5000);
  expect(refusalChecks).toEqual([]);
  expect(windows[1].closeCalls).toBe(0);
});

test("whenStreaming answers true on the pop-out's first frame, at once if it already streamed, and false when it closes first", async () => {
  const { manager, windows, sessions } = harness();
  manager.setPhone(fold());
  manager.open("a.one");
  manager.open("a.two");
  for (const session of sessions) session.appStarted();
  const one = manager.whenStreaming("a.one");
  const two = manager.whenStreaming("a.two");

  sessions[0].sink?.videoPacket({ type: "configuration", data: new Uint8Array([1]) });
  let settled = false;
  void one.then(() => (settled = true));
  await flush();
  expect(settled).toBe(false);

  sessions[0].frame();
  expect(await one).toBe(true);
  expect(await manager.whenStreaming("a.one")).toBe(true);
  windows[1].userClose();
  expect(await two).toBe(false);
  expect(await manager.whenStreaming("a.never")).toBe(false);
});

test("label answers the identified label of an open pop-out, its package before that, and null when it is not open", async () => {
  let identified!: (identity: AppIdentity) => void;
  const { manager } = harness({ identify: () => new Promise((resolve) => (identified = resolve)) });
  manager.setPhone(fold());
  manager.open("com.example.app");
  expect(manager.label("com.example.app")).toBe("com.example.app");

  identified({ label: "Example", icon: null });
  await flush();
  expect(manager.label("com.example.app")).toBe("Example");
  expect(manager.label("a.closed")).toBeNull();
});

test("the window bounds, frame included, are saved once a move or resize has settled for 500 ms", () => {
  vi.useFakeTimers();
  const { manager, windows, saved } = harness();
  manager.setPhone(fold());
  manager.open("com.example.app");

  windows[0].userMove({ x: 50, y: 60, width: 420, height: 930 });
  vi.advanceTimersByTime(300);
  windows[0].userMove({ x: 70, y: 80, width: 440, height: 950 });
  vi.advanceTimersByTime(499);
  expect(saved).toEqual([]);

  vi.advanceTimersByTime(1);
  expect(saved).toEqual([["R5CY", "com.example.app", { x: 70, y: 80, width: 440, height: 950 }]]);
});

test("closing during a pending move saves the final bounds once, and nothing after", () => {
  vi.useFakeTimers();
  const { manager, windows, saved } = harness();
  manager.setPhone(fold());
  manager.open("com.example.app");

  windows[0].userMove({ x: 50, y: 60, width: 420, height: 930 });
  windows[0].userClose();
  vi.advanceTimersByTime(1000);
  expect(saved).toEqual([["R5CY", "com.example.app", { x: 50, y: 60, width: 420, height: 930 }]]);
});

test("a start slower than 5 s is not checked before its app is started, and the 5 s count from the start", async () => {
  vi.useFakeTimers();
  const { manager, windows, sessions, refusalChecks } = harness({ checkRefused: async () => true });
  manager.setPhone(fold());
  manager.open("com.example.app");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(refusalChecks).toEqual([]);
  expect(windows[0].closeCalls).toBe(0);

  sessions[0].appStarted();
  await vi.advanceTimersByTimeAsync(4999);
  expect(refusalChecks).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(refusalChecks).toEqual(["com.example.app"]);
  expect(windows[0].closeCalls).toBe(1);
});

test("frames from the empty display before the app is started do not count as the app streaming", async () => {
  vi.useFakeTimers();
  const { manager, windows, sessions, refusalChecks } = harness({ checkRefused: async () => true });
  manager.setPhone(fold());
  manager.open("com.example.app");
  const streaming = manager.whenStreaming("com.example.app");
  sessions[0].frame();
  sessions[0].appStarted();

  await vi.advanceTimersByTimeAsync(5000);
  expect(refusalChecks).toEqual(["com.example.app"]);
  expect(windows[0].closeCalls).toBe(1);
  expect(await streaming).toBe(false);
});

test("a replaced session's app start is ignored, and the new session's start arms the check", async () => {
  vi.useFakeTimers();
  const { manager, sessions, bindings, refusalChecks } = harness({ checkRefused: async () => false });
  manager.setPhone(fold());
  manager.open("com.example.app");
  bindings[0].handlers.retry();
  sessions[0].appStarted();
  sessions[0].frame();
  await vi.advanceTimersByTimeAsync(5000);
  expect(refusalChecks).toEqual([]);

  sessions[1].appStarted();
  await vi.advanceTimersByTimeAsync(5000);
  expect(refusalChecks).toEqual(["com.example.app"]);
});

test("a closed window's bounds are saved before the count drops, so a quit on the last close never races the save", () => {
  const { manager, windows, saved } = harness();
  manager.setPhone(fold());
  manager.open("com.example.app");
  const savedWhenCounted: number[] = [];
  manager.onCountChanged(() => savedWhenCounted.push(saved.length));

  windows[0].userClose();
  expect(savedWhenCounted).toEqual([1]);
});
