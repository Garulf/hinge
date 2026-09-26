import { MODEL_REST, type ModelAngles } from "../shared/model-rotation";

export interface RotationMemoryDeps {
  /** The turn on screen now. */
  angles(): ModelAngles;
  /** Turns the model at once, for a phone's saved turn. */
  set(angles: ModelAngles): void;
  springToRest(): void;
  save(id: string, angles: ModelAngles): void;
}

/** The model's Alt+drag turn, remembered per phone. */
export class RotationMemory {
  readonly #deps: RotationMemoryDeps;
  #device: string | null = null;

  constructor(deps: RotationMemoryDeps) {
    this.#deps = deps;
  }

  /** A phone started streaming (or is the last one, at startup): a different phone gets its saved turn, or rest. */
  useDevice(id: string, saved: ModelAngles | undefined): void {
    if (this.#device === id) return;
    this.#device = id;
    this.#deps.set(saved ?? MODEL_REST);
  }

  turned(angles: ModelAngles): void {
    if (this.#device) this.#deps.save(this.#device, angles);
  }

  /** Springs back to rest; already at rest there is nothing to spring or save. */
  reset(): void {
    const { yaw, pitch } = this.#deps.angles();
    if (yaw === MODEL_REST.yaw && pitch === MODEL_REST.pitch) return;
    this.#deps.springToRest();
    if (this.#device) this.#deps.save(this.#device, { ...MODEL_REST });
  }
}
