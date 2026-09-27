import { defaultPxPerMm, FOLD7_BODY } from "../shared/layout";
import { fitPxPerMm, nextPxPerMm, pixelPerfectPxPerMm } from "../shared/scale";
import type { Rotation } from "../shared/screen-uv";
import { Spring } from "../shared/spring";

const EASE_MS = 180;
const EASED_PX_PER_MM = 0.002;

export interface ScaleDeps {
  /** Hands the new scale to the scene; the window follows on the next tick. */
  apply(pxPerMm: number): void;
  /** Remembers a scale the user chose for the current phone. */
  persist(pxPerMm: number): void;
}

/**
 * The phone's size on screen in CSS px per mm: the default fills 85 percent
 * of the work area height, MOD+wheel (or the wheel over the frame) steps it
 * by 10 percent, MOD+g snaps the lit screen to 1:1, and fullscreen fits the
 * phone to the screen and gives the windowed size back afterwards. A scale
 * the user picks eases in over a few frames; the steps themselves stay on
 * the 10 percent grid.
 */
export class ScaleController {
  readonly #deps: ScaleDeps;
  #base: number | null = null;
  #max = Infinity;
  #workArea: { w: number; h: number } | null = null;
  #windowed: number | null = null;
  readonly #shown = new Spring({ value: 0, settleMs: EASE_MS });
  #easing = false;
  #fullscreen: number | null = null;
  #device: { id: string; saved: number | null } | null = null;

  constructor(deps: ScaleDeps) {
    this.#deps = deps;
  }

  /** The scale on screen this frame, which trails a step while it eases in. */
  get pxPerMm(): number | null {
    return this.#fullscreen ?? (this.#windowed === null ? null : this.#shown.value);
  }

  /** True while the scale on screen is still easing toward a step. */
  get easing(): boolean {
    return this.#easing;
  }

  get fullscreen(): boolean {
    return this.#fullscreen !== null;
  }

  /** The scale being stepped to as a percentage of the default, for a toast. */
  percent(): number | null {
    const current = this.#fullscreen ?? this.#windowed;
    return current === null || this.#base === null ? null : Math.round((current / this.#base) * 100);
  }

  /** Moves an eased scale on by one frame. */
  tick(dtMs: number): void {
    if (!this.#easing) return;
    this.#shown.step(dtMs);
    this.#shown.snapIfSettled(EASED_PX_PER_MM);
    this.#easing = !this.#shown.settled(0);
    if (this.#fullscreen === null) this.#deps.apply(this.#shown.value);
  }

  setWorkArea(area: { w: number; h: number }): void {
    if (this.#workArea?.w === area.w && this.#workArea.h === area.h) return;
    this.#workArea = area;
    this.#base = defaultPxPerMm(FOLD7_BODY, area.h);
    this.#max = area.h / FOLD7_BODY.heightMm;
    this.#setWindowed(this.#device?.saved ?? this.#windowed ?? this.#base);
  }

  /**
   * A phone started streaming: switching to a different phone takes its
   * saved scale, or the default if it has none; the same phone again keeps
   * whatever scale is on screen. Settings echoes of this controller's own
   * saves never come through here, so a quick run of steps cannot jitter.
   */
  useDevice(id: string, saved: number | undefined): void {
    if (this.#device?.id === id) return;
    this.#device = { id, saved: saved ?? null };
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
    if (this.#windowed !== null) this.#deps.apply(this.#shown.value);
  }

  #choose(pxPerMm: number): void {
    if (this.#device) this.#device.saved = pxPerMm;
    this.#windowed = pxPerMm;
    this.#shown.target = pxPerMm;
    this.#easing = true;
    this.#deps.persist(pxPerMm);
  }

  #setWindowed(pxPerMm: number): void {
    this.#windowed = pxPerMm;
    this.#shown.target = this.#shown.value = pxPerMm;
    this.#shown.velocity = 0;
    this.#easing = false;
    if (this.#fullscreen === null) this.#deps.apply(pxPerMm);
  }
}
