import { shouldAutoShow, UNLOCKED, type Credential, type LockState } from "../../shared/lock";

export interface PadLike {
  open(credential: Credential): void;
  close(): void;
  isOpen(): boolean;
}

export interface UnlockControllerDeps {
  pad: PadLike;
  sendBlack(black: boolean): void;
  /** The showUnlockScreen setting, read on every decision. */
  enabled(): boolean;
}

/**
 * Decides when the unlock pad shows itself: the phone is locked, the mirror
 * shows it as black, and the user has not cancelled the pad since. That
 * cancel lasts until the phone unlocks or the screen shows something again.
 */
export class UnlockController {
  readonly #deps: UnlockControllerDeps;
  #state: LockState = UNLOCKED;
  #black: boolean | null = null;
  #dismissed = false;

  constructor(deps: UnlockControllerDeps) {
    this.#deps = deps;
  }

  screenBlack(black: boolean): void {
    if (black === this.#black) return;
    this.#black = black;
    this.#deps.sendBlack(black);
    if (!black) this.#dismissed = false;
    this.#evaluate();
  }

  lockState(state: LockState): void {
    this.#state = state;
    if (!state.locked) {
      this.#dismissed = false;
      if (this.#deps.pad.isOpen()) this.#deps.pad.close();
    }
    this.#evaluate();
  }

  openByHand(): void {
    this.#deps.pad.open(this.#state.credential);
  }

  cancelled(): void {
    this.#dismissed = true;
  }

  settingsChanged(): void {
    this.#evaluate();
  }

  snapshot(): { black: boolean; locked: boolean; credential: Credential; dismissed: boolean } {
    return { black: this.#black ?? false, locked: this.#state.locked, credential: this.#state.credential, dismissed: this.#dismissed };
  }

  #evaluate(): void {
    if (this.#deps.pad.isOpen()) return;
    const show = shouldAutoShow({ enabled: this.#deps.enabled(), locked: this.#state.locked, black: this.#black ?? false, credential: this.#state.credential, dismissed: this.#dismissed });
    if (show) this.#deps.pad.open(this.#state.credential);
  }
}
