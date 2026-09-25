import type { ScreenClass, ScreenKind } from "./fold7";
import { POSTURE_ANGLE, type Posture, type PostureReading } from "./posture";
import { Spring } from "./spring";

export type ViewMode = "work" | "showcase";

export interface DirectorOutput {
  angle: number;
  trueAngle: number;
  lit: "cover" | "inner" | null;
  coverBrightness: number;
  innerBrightness: number;
  innerVisible: boolean;
  badge: "flex" | null;
  rotation: 0 | 1 | 2 | 3;
  settled: boolean;
}

const DEFAULT_SETTLE_MS = 450;
const FADE_OUT_MS = 200;
const FADE_IN_MS = 150;
const INNER_VISIBLE_ANGLE = 25;
const FRESH_CLASS_MS = 1000;
const POSTURE_LEAD_MS = 1500;

function stepBrightness(value: number, target: number, dtMs: number): number {
  if (value === target) return value;
  const durationMs = target > value ? FADE_IN_MS : FADE_OUT_MS;
  const delta = dtMs / durationMs;
  return target > value ? Math.min(target, value + delta) : Math.max(target, value - delta);
}

/**
 * Whether the window has to fit the open body: the hinge is moving or open,
 * or the inner screen is lit and the model is on its way to it. A model that
 * a closing posture has settled at 0 fits the closed window even while the
 * inner class is still the last one announced (the cover stays dark).
 */
export function bodyIsOpen(out: Pick<DirectorOutput, "angle" | "lit" | "settled">): boolean {
  if (out.angle > 1) return true;
  return out.lit === "inner" && !(out.settled && out.angle === 0);
}

function classTarget(cls: ScreenClass): number {
  return cls.screen === "inner" ? 180 : 0;
}

export class FoldDirector {
  #view: ViewMode;
  #workAngle: Spring;
  #trueAngle: Spring;
  #lit: ScreenKind | null = null;
  #announcedClass: ScreenClass | null = null;
  #lastPosture: Posture | null = null;
  #lastRotation: 0 | 1 | 2 | 3 | null = null;
  #lastLandscape: 1 | 3 | null = null;
  #brightness: Record<ScreenKind, number> = { cover: 0, inner: 0 };
  #brightnessTarget: Record<ScreenKind, number> = { cover: 0, inner: 0 };
  /**
   * The work-view target angle (0 or 180) as an event, not a value derived
   * fresh each tick: a stream class announcement is always the final word,
   * even reconfirming the class already showing, while a posture reading can
   * only move this earlier toward where the class is expected to land next.
   */
  #workTarget = 0;
  #nowMs = 0;
  #classAtMs = 0;
  #leadAtMs: number | null = null;

  constructor(opts?: { view?: ViewMode; settleMs?: number }) {
    this.#view = opts?.view ?? "work";
    const settleMs = opts?.settleMs ?? DEFAULT_SETTLE_MS;
    this.#workAngle = new Spring({ value: 0, settleMs });
    this.#trueAngle = new Spring({ value: 0, settleMs });
  }

  posture(reading: PostureReading): void {
    if (reading.posture !== null) {
      const changed = reading.posture !== this.#lastPosture;
      this.#lastPosture = reading.posture;
      // A reading is delivered again whenever any field changes (rotation
      // included), so only a genuine posture change may nudge the target;
      // otherwise a rotation-only reading would re-lead a target the stream
      // already had the final word on.
      if (changed) this.#nudge(reading.posture);
    }
    if (reading.rotation !== null) this.#lastRotation = reading.rotation;
    if (reading.rotation === 1 || reading.rotation === 3) this.#lastLandscape = reading.rotation;
  }

  /**
   * A posture sample can lag the stream by a sampling interval or more, so
   * one that contradicts a class announced moments ago is stale; and a lead
   * the stream never follows (no class change) runs out, handing the target
   * back to the last announced class.
   */
  #nudge(posture: Posture): void {
    let target: number | null = null;
    if ((posture === "half" || posture === "open") && this.#workTarget === 0) target = 180;
    else if ((posture === "closed" || posture === "tent") && this.#workTarget === 180) target = 0;
    if (target === null) return;
    const cls = this.#announcedClass;
    if (cls && this.#nowMs - this.#classAtMs < FRESH_CLASS_MS && target !== classTarget(cls)) return;
    this.#workTarget = target;
    this.#leadAtMs = cls ? this.#nowMs : null;
  }

  streamClass(cls: ScreenClass): void {
    const previousLit = this.#lit;
    const screenChanged = !this.#announcedClass || this.#announcedClass.screen !== cls.screen;
    this.#announcedClass = cls;
    this.#lit = cls.screen;
    this.#workTarget = classTarget(cls);
    this.#classAtMs = this.#nowMs;
    this.#leadAtMs = null;
    if (screenChanged) {
      if (previousLit) this.#brightnessTarget[previousLit] = 0;
      this.#brightness[cls.screen] = 0;
      this.#brightnessTarget[cls.screen] = 0;
    }
  }

  firstFrame(): void {
    if (this.#lit) this.#brightnessTarget[this.#lit] = 1;
  }

  streamEnded(): void {
    if (this.#lit) this.#brightnessTarget[this.#lit] = 0;
    this.#lit = null;
  }

  setView(view: ViewMode): void {
    this.#view = view;
  }

  tick(dtMs: number): DirectorOutput {
    this.#nowMs += dtMs;
    this.#expireLead();
    this.#workAngle.target = this.#workTarget;
    this.#trueAngle.target = this.#trueAngleTarget();
    this.#workAngle.step(dtMs);
    this.#trueAngle.step(dtMs);
    this.#workAngle.snapIfSettled();
    this.#trueAngle.snapIfSettled();

    this.#brightness.cover = stepBrightness(this.#brightness.cover, this.#brightnessTarget.cover, dtMs);
    this.#brightness.inner = stepBrightness(this.#brightness.inner, this.#brightnessTarget.inner, dtMs);

    const displayed = this.#view === "work" ? this.#workAngle.value : this.#trueAngle.value;
    const fading = this.#brightness.cover !== this.#brightnessTarget.cover || this.#brightness.inner !== this.#brightnessTarget.inner;

    return {
      angle: displayed,
      trueAngle: this.#trueAngle.value,
      lit: this.#lit,
      coverBrightness: this.#brightness.cover,
      innerBrightness: this.#brightness.inner,
      innerVisible: displayed >= INNER_VISIBLE_ANGLE,
      badge: this.#lastPosture === "half" && this.#lit === "inner" ? "flex" : null,
      rotation: this.#rotation(),
      settled: this.#workAngle.settled() && this.#trueAngle.settled() && !fading,
    };
  }

  #expireLead(): void {
    const cls = this.#announcedClass;
    if (this.#leadAtMs === null || !cls || this.#nowMs - this.#leadAtMs < POSTURE_LEAD_MS) return;
    this.#leadAtMs = null;
    this.#workTarget = classTarget(cls);
  }

  #trueAngleTarget(): number {
    if (this.#lastPosture !== null) {
      let angle = POSTURE_ANGLE[this.#lastPosture];
      if (this.#lit === "cover") angle = Math.min(angle, 30);
      else if (this.#lit === "inner") angle = Math.max(angle, 100);
      return angle;
    }
    return this.#announcedClass?.screen === "inner" ? 180 : 0;
  }

  #rotation(): 0 | 1 | 2 | 3 {
    const cls = this.#announcedClass;
    if (cls && !cls.rotated) return 0;
    if (cls && cls.rotated) {
      // Only 1 and 3 are valid rotations for a rotated class; a stale 0 or 2
      // (from before the device turned, or a posture reading that predates
      // this class) cannot be shown as an unrotated stream, so the last
      // landscape rotation seen stands in for it.
      if (this.#lastRotation === 1 || this.#lastRotation === 3) return this.#lastRotation;
      return this.#lastLandscape ?? 1;
    }
    return this.#lastRotation ?? 0;
  }
}
