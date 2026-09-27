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

class FakeWindow implements PopoutWindow {
  readonly port: PortLike = { postMessage: () => {}, onMessage: () => {} };
  focusCalls = 0;
  closeCalls = 0;
  titles: string[] = [];
  icons: Uint8Array[] = [];
  #onClosed: (() => void)[] = [];

  constructor(
    readonly created: { pkg: string; title: string; bounds: Rect | null; content: { width: number; height: number } },
    private readonly scale = 1,
  ) {}

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
    return { x: 10, y: 20, ...this.created.content };
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
  #finishStart!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.#finishStart = resolve;
  });

  constructor(
    readonly phone: ConnectedPhone,
    readonly pkg: string,
    readonly geometry: DisplayGeometry,
  ) {}

  start(): Promise<void> {
    this.startCalls++;
    return this.started;
  }

  finishStart(): void {
    this.#finishStart();
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

function harness(opts: { savedBounds?: Rect | null; identify?: (pkg: string) => Promise<AppIdentity> } = {}) {
  const windows: FakeWindow[] = [];
  const sessions: FakeSession[] = [];
  const bindings: Binding[] = [];
  const notices: string[] = [];
  const saved: [string, string, Rect][] = [];
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
    log: () => {},
  };
  const manager = new PopoutManager(deps);
  const counts: number[] = [];
  manager.onCountChanged((n) => counts.push(n));
  return { manager, windows, sessions, bindings, notices, saved, counts };
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

test("a saved size is reused for the window and its display", () => {
  const { manager, windows, sessions } = harness({ savedBounds: { x: 5, y: 6, width: 400, height: 860 } });
  manager.setPhone(fold());
  manager.open("com.example.app");

  expect(windows[0].created.bounds).toEqual({ x: 5, y: 6, width: 400, height: 860 });
  expect(windows[0].created.content).toEqual({ width: 400, height: 860 });
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
  expect(saved).toEqual([["R5CY", "com.example.app", { x: 10, y: 20, width: 379, height: 884 }]]);

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
