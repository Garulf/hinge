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
  saved(serial: string): Corner | undefined;
  save(serial: string, corner: Corner): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const SAVE_DELAY_MS = 500;

/** Remembers where the window was for each phone, and puts it back there when that phone streams again. */
export class DevicePlacement {
  readonly #deps: PlacementDeps;
  #serial: string | null = null;
  #pending: unknown = null;

  constructor(deps: PlacementDeps) {
    this.#deps = deps;
  }

  status(status: SessionStatus): void {
    if (status.state !== "streaming" || status.serial === this.#serial) return;
    this.#cancelSave();
    this.#serial = status.serial;
    const corner = this.#deps.saved(status.serial);
    if (corner) this.#deps.setContentBounds(restoredBounds(this.#deps.getContentBounds(), corner, this.#deps.workAreaFor));
  }

  /** After a drag ends or the window system reports a move; settles for a moment first, since a move can come in bursts. */
  moved(): void {
    const serial = this.#serial;
    if (!serial) return;
    this.#cancelSave();
    const set = this.#deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#pending = set(() => {
      this.#pending = null;
      if (this.#serial === serial) this.#deps.save(serial, cornerOf(this.#deps.getContentBounds()));
    }, SAVE_DELAY_MS);
  }

  #cancelSave(): void {
    if (this.#pending === null) return;
    (this.#deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.#pending);
    this.#pending = null;
  }
}
