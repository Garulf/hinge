import { deviceAlignedSize, lerpSize } from "./layout";

/**
 * The window size partway through the view transition: the work size at
 * t 0, the showcase size at t 1, and in between a device-aligned blend
 * capped at the larger of the two, so alignment never pushes it past the
 * showcase's fit to the work area.
 */
export function viewWindowSize(
  work: { w: number; h: number },
  showcase: { w: number; h: number },
  t: number,
  devicePixelRatio: number,
): { w: number; h: number } {
  if (t <= 0) return work;
  if (t >= 1) return showcase;
  const aligned = deviceAlignedSize(lerpSize(work, showcase, t), devicePixelRatio);
  return { w: Math.min(aligned.w, Math.max(work.w, showcase.w)), h: Math.min(aligned.h, Math.max(work.h, showcase.h)) };
}
