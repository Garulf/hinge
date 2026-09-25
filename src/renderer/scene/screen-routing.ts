import type { ScreenClass, ScreenKind } from "../../shared/fold7";
import type { Rotation } from "../../shared/screen-uv";

export interface Handoff {
  from: ScreenKind | null;
  to: ScreenKind;
}

/**
 * Tracks which screen carries the live stream and which rotation its frames
 * are sampled with. A class change on the same screen (the stream turning
 * between portrait and landscape) keeps brightness up, so the old-size frame
 * still in the texture must keep its old rotation until the new class's
 * first frame replaces it.
 */
export class ScreenRouting {
  #videoScreen: ScreenKind | null = null;
  #cls: ScreenClass | null = null;
  #held: Rotation | null = null;
  #shown: Rotation = 0;

  get videoScreen(): ScreenKind | null {
    return this.#videoScreen;
  }

  streamClass(cls: ScreenClass): Handoff | null {
    const previous = this.#cls;
    this.#cls = cls;
    if (this.#videoScreen !== cls.screen) {
      const from = this.#videoScreen;
      this.#videoScreen = cls.screen;
      this.#held = null;
      return { from, to: cls.screen };
    }
    if (previous && previous.rotated !== cls.rotated) this.#held ??= this.#shown;
    return null;
  }

  firstFrame(): void {
    this.#held = null;
  }

  rotation(directorRotation: Rotation): Rotation {
    this.#shown = this.#held ?? directorRotation;
    return this.#shown;
  }
}
