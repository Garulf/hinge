import { displayGeometry, initialContentSize, MAX_POPOUTS, MIN_DISPLAY_PX, RESIZE_DEBOUNCE_MS, ResizeDebouncer, type DisplayGeometry } from "../shared/popout";
import type { ControlIntent, SessionStatus } from "../shared/wire";
import type { ConnectedPhone, PortLike } from "./app-controller";
import type { MediaSink, MediaSource } from "./media-source";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoutWindow {
  readonly port: PortLike;
  focus(): void;
  close(): void;
  setTitle(title: string): void;
  setIcon(png: Uint8Array): void;
  /** Must still answer, with the last known bounds, from inside an onClosed callback. */
  contentBounds(): Rect;
  scaleFactor(): number;
  onClosed(cb: () => void): void;
}

export interface PopoutSessionLike extends MediaSource {
  resize(g: DisplayGeometry): void;
}

export interface AppIdentity {
  label: string;
  icon: Uint8Array | null;
}

export interface PopoutManagerDeps {
  createWindow(o: { pkg: string; title: string; bounds: Rect | null; content: { width: number; height: number } }): PopoutWindow;
  createSession(phone: ConnectedPhone, pkg: string, g: DisplayGeometry): PopoutSessionLike;
  /** Starts the session once the window's renderer is ready, as bindSource does; called once per window. */
  bindPort(
    session: PopoutSessionLike,
    port: PortLike,
    handlers: { viewport(w: number, h: number, dpr: number): void; retry(): void },
  ): { status(s: SessionStatus): void };
  identify(phone: ConnectedPhone, pkg: string): Promise<AppIdentity>;
  workArea(): { width: number; height: number };
  savedBounds(deviceId: string, pkg: string): Rect | null;
  saveBounds(deviceId: string, pkg: string, r: Rect): void;
  notice(text: string): void;
  log(line: string): void;
  /** Whether the app is resumed on the phone's own screen, read without sending the phone any input. */
  checkRefused(phone: ConnectedPhone, pkg: string): Promise<boolean>;
}

export type OpenResult = "opened" | "focused" | "queued" | "limit";

const LIMIT_NOTICE = `Up to ${MAX_POPOUTS} apps can be open at once`;
/** An app that refuses secondary displays opens on the phone screen instead, and its pop-out never gets a frame. */
const REFUSAL_CHECK_MS = 5000;

function watchFrames(sink: MediaSink, onFrame: () => void): MediaSink {
  return {
    ...sink,
    videoPacket: (packet) => {
      if (packet.type === "data") onFrame();
      sink.videoPacket(packet);
    },
  };
}

/**
 * The one session a window's port is bound to for the window's whole life.
 * The phone's sessions come and go underneath it (reconnects, retries), and
 * each new one is started with the sink the renderer's "ready" produced.
 */
class SessionSlot implements PopoutSessionLike {
  #current: PopoutSessionLike | null = null;
  #sink: MediaSink | null = null;
  #closed = false;

  constructor(
    private readonly log: (line: string) => void,
    private readonly onFrame: () => void,
  ) {}

  async start(sink: MediaSink): Promise<void> {
    this.#sink = watchFrames(sink, this.onFrame);
    await this.#current?.start(this.#sink);
  }

  control(intent: ControlIntent): void {
    this.#current?.control(intent);
  }

  resize(g: DisplayGeometry): void {
    this.#current?.resize(g);
  }

  async stop(): Promise<void> {
    this.#closed = true;
    await this.#swap(null);
  }

  replace(next: PopoutSessionLike | null): void {
    if (this.#closed) return;
    void this.#swap(next);
    const sink = this.#sink;
    if (next && sink) next.start(sink).catch((e) => this.log(`pop-out session failed to start: ${String(e)}`));
  }

  async #swap(next: PopoutSessionLike | null): Promise<void> {
    const previous = this.#current;
    this.#current = next;
    await previous?.stop().catch((e) => this.log(`pop-out session failed to stop: ${String(e)}`));
  }
}

interface Entry {
  pkg: string;
  deviceId: string;
  window: PopoutWindow;
  slot: SessionSlot;
  geometry: DisplayGeometry;
  debouncer: ResizeDebouncer;
  status: (s: SessionStatus) => void;
  label: string;
  streamed: boolean;
  streamWaiters: ((streamed: boolean) => void)[];
  refusalTimer: ReturnType<typeof setTimeout>;
}

export class PopoutManager {
  #phone: ConnectedPhone | null = null;
  readonly #entries = new Map<string, Entry>();
  readonly #queued = new Set<string>();
  readonly #countListeners: ((n: number) => void)[] = [];

  constructor(private readonly deps: PopoutManagerDeps) {}

  open(pkg: string): OpenResult {
    const existing = this.#entries.get(pkg);
    if (existing) {
      existing.window.focus();
      return "focused";
    }
    if (this.#queued.has(pkg)) return "queued";
    if (this.#entries.size + this.#queued.size >= MAX_POPOUTS) {
      this.deps.notice(LIMIT_NOTICE);
      return "limit";
    }
    const phone = this.#phone;
    if (!phone) {
      this.#queued.add(pkg);
      return "queued";
    }
    this.#openWindow(phone, pkg);
    return "opened";
  }

  setPhone(phone: ConnectedPhone | null): void {
    const previous = this.#phone;
    this.#phone = phone;
    if (!phone) {
      if (previous) this.#showReconnecting(previous);
      return;
    }
    if (previous && previous.adb === phone.adb && previous.deviceId === phone.deviceId) {
      this.#openQueued(phone);
      return;
    }
    for (const entry of [...this.#entries.values()]) {
      if (entry.deviceId === phone.deviceId) this.#restartSession(entry, phone);
      else this.#close(entry).catch((e) => this.deps.log(`closing ${entry.pkg} failed: ${String(e)}`));
    }
    this.#openQueued(phone);
  }

  count(): number {
    return this.#entries.size;
  }

  /** True once the app's open pop-out has shown a frame; false if it closes first or is not open. */
  whenStreaming(pkg: string): Promise<boolean> {
    const entry = this.#entries.get(pkg);
    if (!entry) return Promise.resolve(false);
    if (entry.streamed) return Promise.resolve(true);
    return new Promise((resolve) => entry.streamWaiters.push(resolve));
  }

  /** The app's label while its pop-out is open, its package until it is identified. */
  label(pkg: string): string | null {
    return this.#entries.get(pkg)?.label ?? null;
  }

  onCountChanged(cb: (n: number) => void): void {
    this.#countListeners.push(cb);
  }

  async closeAll(): Promise<void> {
    this.#queued.clear();
    const entries = [...this.#entries.values()];
    await Promise.all(entries.map((entry) => this.#close(entry)));
  }

  #openWindow(phone: ConnectedPhone, pkg: string): void {
    const saved = this.deps.savedBounds(phone.deviceId, pkg);
    const content = saved && saved.width > 0 && saved.height > 0 ? { width: saved.width, height: saved.height } : initialContentSize(this.deps.workArea());
    const window = this.deps.createWindow({ pkg, title: pkg, bounds: saved, content });
    const scale = window.scaleFactor();
    const geometry = displayGeometry(content.width, content.height, scale) ?? { width: MIN_DISPLAY_PX, height: MIN_DISPLAY_PX, dpi: Math.round(160 * scale) };
    const slot = new SessionSlot(this.deps.log, () => this.#streamed(entry));
    const entry: Entry = {
      pkg,
      deviceId: phone.deviceId,
      window,
      slot,
      geometry,
      debouncer: new ResizeDebouncer(RESIZE_DEBOUNCE_MS, (g) => {
        entry.geometry = g;
        slot.resize(g);
      }),
      status: () => {},
      label: pkg,
      streamed: false,
      streamWaiters: [],
      refusalTimer: setTimeout(() => this.#checkRefused(entry), REFUSAL_CHECK_MS),
    };
    entry.debouncer.prime(geometry);
    this.#entries.set(pkg, entry);
    window.onClosed(() => {
      this.#forget(entry).catch((e) => this.deps.log(`closing ${pkg} failed: ${String(e)}`));
    });
    slot.replace(this.deps.createSession(phone, pkg, geometry));
    entry.status = this.deps.bindPort(slot, window.port, {
      viewport: (w, h, dpr) => entry.debouncer.push(displayGeometry(w, h, dpr)),
      retry: () => this.#retry(entry),
    }).status;
    this.#countChanged();
    this.#identify(entry, phone);
  }

  #identify(entry: Entry, phone: ConnectedPhone): void {
    this.deps
      .identify(phone, entry.pkg)
      .then((identity) => {
        if (this.#entries.get(entry.pkg) !== entry) return;
        entry.label = identity.label;
        entry.window.setTitle(identity.label);
        if (identity.icon) entry.window.setIcon(identity.icon);
      })
      .catch((e) => this.deps.log(`identifying ${entry.pkg} failed: ${String(e)}`));
  }

  #streamed(entry: Entry): void {
    if (entry.streamed) return;
    entry.streamed = true;
    clearTimeout(entry.refusalTimer);
    for (const resolve of entry.streamWaiters.splice(0)) resolve(true);
  }

  #checkRefused(entry: Entry): void {
    const phone = this.#phone;
    const pending = () => this.#entries.get(entry.pkg) === entry && !entry.streamed;
    if (!phone || phone.deviceId !== entry.deviceId || !pending()) return;
    this.deps
      .checkRefused(phone, entry.pkg)
      .then((refused) => {
        if (!refused || !pending()) return;
        this.deps.notice(`${entry.label} can't run in its own window`);
        return this.#close(entry);
      })
      .catch((e) => this.deps.log(`checking whether ${entry.pkg} runs in its own window failed: ${String(e)}`));
  }

  #openQueued(phone: ConnectedPhone): void {
    const queued = [...this.#queued];
    this.#queued.clear();
    for (const pkg of queued) this.#openWindow(phone, pkg);
  }

  #showReconnecting(lost: ConnectedPhone): void {
    for (const entry of this.#entries.values()) {
      entry.slot.replace(null);
      entry.status({ state: "connecting", serial: lost.serial });
    }
  }

  #restartSession(entry: Entry, phone: ConnectedPhone): void {
    entry.slot.replace(this.deps.createSession(phone, entry.pkg, entry.geometry));
  }

  #retry(entry: Entry): void {
    const phone = this.#phone;
    if (!phone || phone.deviceId !== entry.deviceId || this.#entries.get(entry.pkg) !== entry) return;
    this.#restartSession(entry, phone);
  }

  /** A window that fails to close is only logged, so it cannot keep the others open. */
  async #close(entry: Entry): Promise<void> {
    if (this.#entries.get(entry.pkg) !== entry) return;
    const stopped = this.#forget(entry);
    try {
      entry.window.close();
    } catch (e) {
      this.deps.log(`closing the ${entry.pkg} window failed: ${String(e)}`);
    }
    await stopped;
  }

  /**
   * Stops the session before anything that can throw, so a failure cannot
   * leak the session and its virtual display. A second call
   * for the same entry (onClosed firing for a window the manager closed
   * itself) is a no-op.
   */
  async #forget(entry: Entry): Promise<void> {
    if (this.#entries.get(entry.pkg) !== entry) return;
    this.#entries.delete(entry.pkg);
    entry.debouncer.cancel();
    clearTimeout(entry.refusalTimer);
    for (const resolve of entry.streamWaiters.splice(0)) resolve(false);
    const stopped = entry.slot.stop();
    this.#countChanged();
    this.#saveBounds(entry);
    await stopped;
  }

  #saveBounds(entry: Entry): void {
    try {
      this.deps.saveBounds(entry.deviceId, entry.pkg, entry.window.contentBounds());
    } catch (e) {
      this.deps.log(`saving the ${entry.pkg} window bounds failed: ${String(e)}`);
    }
  }

  #countChanged(): void {
    const n = this.#entries.size;
    for (const cb of this.#countListeners) cb(n);
  }
}
