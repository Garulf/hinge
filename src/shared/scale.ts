import type { BodyDims } from "./layout";
import type { Rotation } from "./screen-uv";

export const SCALE_STEP = 0.1;
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 3;

const GRID_EPSILON = 1e-6;

/** The next 10 percent step up or down from `scale` (1 = the default size), snapping an off-grid scale onto the grid. */
export function stepScale(scale: number, direction: 1 | -1): number {
  const steps = scale / SCALE_STEP;
  const next = direction > 0 ? Math.floor(steps + GRID_EPSILON) + 1 : Math.ceil(steps - GRID_EPSILON) - 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next) * SCALE_STEP));
}

const WHEEL_NOTCH = 100;

/** Accumulates wheel deltas into whole notches, so a touchpad's stream of small deltas scales at the same rate as a wheel. */
export class WheelSteps {
  #accumulated = 0;

  add(delta: number): number {
    if (Math.sign(delta) !== Math.sign(this.#accumulated)) this.#accumulated = 0;
    this.#accumulated += delta;
    const steps = Math.trunc(this.#accumulated / WHEEL_NOTCH) || 0;
    this.#accumulated -= steps * WHEEL_NOTCH;
    return steps;
  }
}

const FIT_MARGIN = 0.92;

/** The largest scale at which the open body fits in the viewport, for fullscreen. */
export function fitPxPerMm(body: BodyDims, rotation: Rotation, viewport: { w: number; h: number }): number {
  const sideways = rotation === 1 || rotation === 3;
  const along = sideways ? { w: body.heightMm, h: body.openWidthMm } : { w: body.openWidthMm, h: body.heightMm };
  return FIT_MARGIN * Math.min(viewport.w / along.w, viewport.h / along.h);
}

/** The scale at which the lit screen shows one video pixel per device pixel (scrcpy's MOD+g). */
export function pixelPerfectPxPerMm(video: { w: number; h: number }, screenMm: { w: number; h: number }, devicePixelRatio: number): number {
  const videoLong = Math.max(video.w, video.h);
  const screenLong = Math.max(screenMm.w, screenMm.h);
  return videoLong / devicePixelRatio / screenLong;
}
