import { clampToWorkArea, type Rect } from "../shared/clamp-bounds";
import type { SessionStatus } from "../shared/wire";

export interface Corner {
  x: number;
  y: number;
}

/** Saved as the top-right corner: the fixed half's edge, which folding keeps in place, so the corner holds whether the phone was open or closed. */
export function cornerOf(bounds: Rect): Corner {
  return { x: bounds.x + bounds.width, y: bounds.y };
}

/** The current window moved to a saved corner, kept inside the work area of whichever display that lands on. */
export function restoredBounds(current: Rect, corner: Corner, workAreaFor: (rect: Rect) => Rect): Rect {
  const target = { x: Math.round(corner.x - current.width), y: Math.round(corner.y), width: current.width, height: current.height };
  return clampToWorkArea(target, workAreaFor(target));
}

export interface PlacementDeps {
  getContentBounds(): Rect;
  setContentBounds(bounds: Rect): void;
  workAreaFor(rect: Rect): Rect;
  saved(id: string): Corner | undefined;
  save(id: string, corner: Corner): void;
  /** A fullscreen window is left where it is; the corner is for the windowed phone. */
  isFullScreen?(): boolean;
  /** After the window moved to a saved corner, which may be on another display. */
  restored?(): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const SAVE_DELAY_MS = 500;

/** Remembers where the window was for each phone, and puts it back there when that phone streams again. */
export class DevicePlacement {
  readonly #deps: PlacementDeps;
  #device: string | null = null;
  #pending: { handle: unknown; save: () => void } | null = null;
  #closed = false;

  constructor(deps: PlacementDeps) {
    this.#deps = deps;
  }

  /** At startup, before any phone streams: the last phone's corner, so the window does not jump once it does. */
  preApply(id: string | null): void {
    if (!id || this.#closed) return;
    const corner = this.#deps.saved(id);
    if (!corner) return;
    this.#device = id;
    this.#restore(corner);
  }

  status(status: SessionStatus): void {
    if (this.#closed || status.state !== "streaming" || status.deviceId === this.#device) return;
    this.#cancelSave();
    this.#device = status.deviceId;
    const corner = this.#deps.saved(status.deviceId);
    if (corner && !this.#deps.isFullScreen?.()) this.#restore(corner);
  }

  /** After a drag ends or the window system reports a move; settles for a moment first, since a move can come in bursts. */
  moved(): void {
    const id = this.#device;
    if (!id || this.#closed) return;
    this.#cancelSave();
    const save = (): void => {
      this.#pending = null;
      if (this.#device === id) this.#deps.save(id, cornerOf(this.#deps.getContentBounds()));
    };
    const set = this.#deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#pending = { handle: set(save, SAVE_DELAY_MS), save };
  }

  /** The window is closing and its bounds can still be read: a move still settling is saved now rather than lost. */
  flush(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#cancelSave();
    pending.save();
  }

  /** The window is gone: nothing may read its bounds from here on. */
  closed(): void {
    this.#closed = true;
    this.#cancelSave();
  }

  #restore(corner: Corner): void {
    this.#deps.setContentBounds(restoredBounds(this.#deps.getContentBounds(), corner, this.#deps.workAreaFor));
    this.#deps.restored?.();
  }

  #cancelSave(): void {
    if (this.#pending === null) return;
    (this.#deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.#pending.handle);
    this.#pending = null;
  }
}
