export type ScreenKind = "cover" | "inner";
export interface ScreenClass { screen: ScreenKind; rotated: boolean }
export interface ScreenSpec { px: { w: number; h: number } }

export const FOLD7 = {
  cover: { px: { w: 1080, h: 2520 } },
  inner: { px: { w: 1968, h: 2184 } },
} as const satisfies Record<ScreenKind, ScreenSpec>;

const COVER_MIN_ASPECT = 1.6;
const INNER_MAX_ASPECT = 1.3;

export function classifyScreen(width: number, height: number, previous: ScreenClass | null): ScreenClass {
  const rotated = width > height;
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect >= COVER_MIN_ASPECT) return { screen: "cover", rotated };
  if (aspect <= INNER_MAX_ASPECT) return { screen: "inner", rotated };
  return { screen: previous?.screen ?? "inner", rotated };
}
