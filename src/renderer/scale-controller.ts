import { defaultPxPerMm, FOLD7_BODY } from "../shared/layout";
import { fitPxPerMm, nextPxPerMm, pixelPerfectPxPerMm } from "../shared/scale";
import type { Rotation } from "../shared/screen-uv";

export interface ScaleDeps {
  /** Hands the new scale to the scene; the window follows on the next tick. */
  apply(pxPerMm: number): void;
  /** Remembers a scale the user chose for the current phone. */
  persist(pxPerMm: number): void;
}

/**
 * The phone's size on screen in CSS px per mm: the default fills 85 percent
 * of the work area height, MOD+wheel steps it by 10 percent, MOD+g snaps
 * the lit screen to 1:1, and fullscreen fits the phone to the screen and
 * gives the windowed size back afterwards.
 */
export class ScaleController {
  readonly #deps: ScaleDeps;
  #base: number | null = null;
  #max = Infinity;
  #windowed: number | null = null;
  #fullscreen: number | null = null;
  #device: { serial: string; saved: number | null } | null = null;

  constructor(deps: ScaleDeps) {
    this.#deps = deps;
  }

  get pxPerMm(): number | null {
    return this.#fullscreen ?? this.#windowed;
  }

  get fullscreen(): boolean {
    return this.#fullscreen !== null;
  }

  /** Scale as a percentage of the default, for a toast. */
  percent(): number | null {
    const current = this.pxPerMm;
    return current === null || this.#base === null ? null : Math.round((current / this.#base) * 100);
  }

  setWorkArea(heightPx: number): void {
    this.#base = defaultPxPerMm(FOLD7_BODY, heightPx);
    this.#max = heightPx / FOLD7_BODY.heightMm;
    this.#setWindowed(this.#device?.saved ?? this.#windowed ?? this.#base);
  }

  /**
   * A phone started streaming: switching to a different phone takes its
   * saved scale, or the default if it has none; the same phone again keeps
   * whatever scale is on screen. Settings echoes of this controller's own
   * saves never come through here, so a quick run of steps cannot jitter.
   */
  useDevice(serial: string, saved: number | undefined): void {
    if (this.#device?.serial === serial) return;
    this.#device = { serial, saved: saved ?? null };
    if (this.#base !== null) this.#setWindowed(saved ?? this.#base);
  }

  step(direction: 1 | -1): boolean {
    if (this.fullscreen || this.#base === null || this.#windowed === null) return false;
    this.#choose(nextPxPerMm(this.#windowed, this.#base, direction, this.#max));
    return true;
  }

  pixelPerfect(video: { w: number; h: number } | null, screenMm: { w: number; h: number } | null, devicePixelRatio: number): boolean {
    if (this.fullscreen || !video || !screenMm) return false;
    this.#choose(pixelPerfectPxPerMm(video, screenMm, devicePixelRatio));
    return true;
  }

  /** Called on every tick while fullscreen, since the screen size and the phone's rotation can both change. */
  fitFullscreen(rotation: Rotation, viewport: { w: number; h: number }): void {
    const fit = fitPxPerMm(FOLD7_BODY, rotation, viewport);
    if (fit === this.#fullscreen) return;
    this.#fullscreen = fit;
    this.#deps.apply(fit);
  }

  leaveFullscreen(): void {
    if (this.#fullscreen === null) return;
    this.#fullscreen = null;
    if (this.#windowed !== null) this.#deps.apply(this.#windowed);
  }

  #choose(pxPerMm: number): void {
    if (this.#device) this.#device.saved = pxPerMm;
    this.#setWindowed(pxPerMm);
    this.#deps.persist(pxPerMm);
  }

  #setWindowed(pxPerMm: number): void {
    this.#windowed = pxPerMm;
    if (this.#fullscreen === null) this.#deps.apply(pxPerMm);
  }
}
