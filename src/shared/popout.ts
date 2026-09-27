import { FOLD7 } from "./fold7";

export const MAX_POPOUTS = 4;
export const RESIZE_DEBOUNCE_MS = 150;
export const MIN_DISPLAY_PX = 128;

export interface DisplayGeometry {
  width: number;
  height: number;
  dpi: number;
}

function toDisplayPx(css: number, dpr: number): number {
  return Math.max(MIN_DISPLAY_PX, Math.floor((css * dpr) / 8) * 8);
}

/** 1 dp = 1 CSS px, so Android picks its phone or tablet layout from the window's CSS width. */
export function displayGeometry(contentW: number, contentH: number, dpr: number): DisplayGeometry | null {
  if (contentW <= 0 || contentH <= 0) return null;
  return { width: toDisplayPx(contentW, dpr), height: toDisplayPx(contentH, dpr), dpi: Math.round(160 * dpr) };
}

export function initialContentSize(workArea: { width: number; height: number }): { width: number; height: number } {
  const height = Math.round(workArea.height * 0.85);
  const aspect = FOLD7.cover.px.w / FOLD7.cover.px.h;
  return { width: Math.round(height * aspect), height };
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface Timers {
  set(fn: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

const globalTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};

function sameGeometry(a: DisplayGeometry, b: DisplayGeometry): boolean {
  return a.width === b.width && a.height === b.height && a.dpi === b.dpi;
}

export class ResizeDebouncer {
  #timer: TimerHandle | null = null;
  #last: DisplayGeometry | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly fire: (g: DisplayGeometry) => void,
    private readonly timers: Timers = globalTimers,
  ) {}

  /** Records the geometry the display already has, so pushing it again is not a change. */
  prime(g: DisplayGeometry): void {
    this.#last = g;
  }

  push(g: DisplayGeometry | null): void {
    if (!g) return;
    this.cancel();
    this.#timer = this.timers.set(() => {
      this.#timer = null;
      if (this.#last && sameGeometry(this.#last, g)) return;
      this.#last = g;
      this.fire(g);
    }, this.delayMs);
  }

  cancel(): void {
    if (this.#timer !== null) this.timers.clear(this.#timer);
    this.#timer = null;
  }
}

const PER_APP_PLAIN = new Set(["KeyB", "Backspace", "KeyC", "KeyX", "KeyV", "ArrowUp", "ArrowDown"]);
const PER_APP_SHIFT = new Set(["KeyV", "KeyR"]);

export function popoutAllows(code: string, shift: boolean): boolean {
  return shift ? PER_APP_SHIFT.has(code) : PER_APP_PLAIN.has(code);
}
