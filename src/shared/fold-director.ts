import type { ScreenClass, ScreenKind } from "./fold7";
import { POSTURE_ANGLE, type Posture, type PostureReading } from "./posture";
import { Spring } from "./spring";

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
const LEAD_DISPUTE_FRAME_MS = 300;

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

function postureTarget(posture: Posture): number {
  return posture === "half" || posture === "open" ? 180 : 0;
}

export class FoldDirector {
  #blend: number;
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
  #lastFrameAtMs: number | null = null;
  #probedLeadAtMs: number | null = null;
  readonly #requestFrames: () => void;

  /** `requestFrames` asks the stream to resend its screen (scrcpy's reset-video), for a lead whose screen has sent nothing. */
  constructor(opts?: { settleMs?: number; requestFrames?: () => void }) {
    this.#requestFrames = opts?.requestFrames ?? (() => {});
    this.#blend = 0;
    const settleMs = opts?.settleMs ?? DEFAULT_SETTLE_MS;
    this.#workAngle = new Spring({ value: 0, settleMs });
    this.#trueAngle = new Spring({ value: 0, settleMs });
  }

  posture(reading: PostureReading): void {
    if (reading.posture !== null) {
      const previous = this.#lastPosture;
      this.#lastPosture = reading.posture;
      // A reading is delivered again whenever any field changes (rotation
      // included, or half and open trading places while the phone rests
      // near the detent), so only a posture that points the other way may
      // nudge the target; otherwise it would re-lead a target the stream
      // already had the final word on.
      if (previous === null || postureTarget(previous) !== postureTarget(reading.posture)) this.#nudge(reading.posture);
    }
    if (reading.rotation !== null) this.#lastRotation = reading.rotation;
    if (reading.rotation === 1 || reading.rotation === 3) this.#lastLandscape = reading.rotation;
  }

  /**
   * A posture sample can lag the stream by a sampling interval or more, so
   * one that contradicts a class announced moments ago is stale (and within
   * that window every nudge does); a lead the stream disputes runs out,
   * handing the target back to the last announced class.
   */
  #nudge(posture: Posture): void {
    const target = postureTarget(posture);
    if (target === this.#workTarget) return;
    const cls = this.#announcedClass;
    if (cls && this.#nowMs - this.#classAtMs < FRESH_CLASS_MS) return;
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

  /** Every decoded frame of the announced class. */
  frame(): void {
    this.#lastFrameAtMs = this.#nowMs;
  }

  firstFrame(): void {
    if (this.#lit) this.#brightnessTarget[this.#lit] = 1;
  }

  streamEnded(): void {
    if (this.#lit) this.#brightnessTarget[this.#lit] = 0;
    this.#lit = null;
  }

  /** `blend` runs from 0 (the work angle) to 1 (the true angle) as the phone turns from straight on to the showcase look. */
  setBlend(blend: number): void {
    this.#blend = blend;
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

    const work = this.#workAngle.value;
    const displayed = work + (this.#trueAngle.value - work) * this.#blend;
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

  /**
   * A screen that goes dark on a fold sends no frames, so the stream only
   * disputes a lead by still sending frames of its class well after the
   * posture changed; without that the lead stands. scrcpy also sends
   * nothing while a lit screen does not change, so a lead that runs out in
   * silence asks for the screen once: a lit one answers with frames, a dark
   * one stays silent and the lead holds.
   */
  #expireLead(): void {
    const cls = this.#announcedClass;
    const leadAt = this.#leadAtMs;
    if (leadAt === null || !cls || this.#nowMs - leadAt < POSTURE_LEAD_MS) return;
    if (this.#lastFrameAtMs === null || this.#lastFrameAtMs < leadAt + LEAD_DISPUTE_FRAME_MS) {
      if (this.#probedLeadAtMs !== leadAt) {
        this.#probedLeadAtMs = leadAt;
        this.#requestFrames();
      }
      return;
    }
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
