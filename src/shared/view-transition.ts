export interface CameraPose {
  kind: "ortho" | "persp";
  yaw: number;
  pitch: number;
  distance: number;
  fovDeg: number;
  blend: number;
}

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

/** Blends work (t=0) and showcase (t=1) over a fixed duration, ease-in-out, reversible mid-flight. */
export class ViewTransition {
  target: "work" | "showcase" = "work";
  readonly #durationMs: number;
  #p = 0;

  constructor(opts?: { durationMs?: number }) {
    this.#durationMs = opts?.durationMs ?? 600;
  }

  toggle(): void {
    this.setTarget(this.target === "work" ? "showcase" : "work");
  }

  /** Eases toward `target` from wherever the blend stands, or with `instant` lands on it at once. */
  setTarget(target: "work" | "showcase", opts?: { instant?: boolean }): void {
    this.target = target;
    if (opts?.instant) this.#p = target === "showcase" ? 1 : 0;
  }

  tick(dtMs: number): { t: number; active: boolean } {
    const goal = this.target === "showcase" ? 1 : 0;
    if (this.#p !== goal) {
      const step = dtMs / this.#durationMs;
      this.#p = goal > this.#p ? Math.min(goal, this.#p + step) : Math.max(goal, this.#p - step);
    }
    return { t: easeInOutCubic(this.#p), active: this.#p !== goal };
  }
}
