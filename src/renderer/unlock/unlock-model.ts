import type { Credential, UnlockRequest, UnlockResult } from "../../shared/lock";
import type { HitId, UnlockMode } from "./unlock-layout";

export interface UnlockView {
  mode: UnlockMode;
  busy: boolean;
  error: boolean;
  prompt: string;
  hint: string | null;
  /** How many characters are entered; the characters themselves never leave the model. */
  entered: number;
  okEnabled: boolean;
  pressed: HitId | null;
  switchLabel: string | null;
  shakeSince: number | null;
}

export interface UnlockModelDeps {
  submit(request: UnlockRequest): void;
  cancel(): void;
  now(): number;
}

export interface KeyLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const PROMPTS: Record<UnlockMode, string> = { pin: "Enter PIN", password: "Enter password", pattern: "Pattern unlock isn't supported yet" };
const HINTS: Record<UnlockMode, string | null> = { pin: null, password: "Type on your keyboard, then press Enter", pattern: "Unlock on the phone." };
/** Android's own minimum for a PIN or password. */
const MIN_LENGTH = 4;
const MAX_LENGTH: Record<UnlockMode, number> = { pin: 16, password: 64, pattern: 0 };

export class UnlockModel {
  readonly #deps: UnlockModelDeps;
  #mode: UnlockMode = "pin";
  #canSwitch = false;
  #entry = "";
  #busy = false;
  #submitted = 0;
  #prompt = PROMPTS.pin;
  #error = false;
  #pressed: HitId | null = null;
  #shakeSince: number | null = null;

  constructor(deps: UnlockModelDeps) {
    this.#deps = deps;
  }

  open(credential: Credential): void {
    this.#canSwitch = credential === "unknown" || credential === "none";
    this.#setMode(credential === "password" ? "password" : credential === "pattern" ? "pattern" : "pin");
  }

  /** Forgets whatever was typed or pressed, for a pad closed without a result. */
  clear(): void {
    this.#setMode(this.#mode);
  }

  canSwitch(): boolean {
    return this.#canSwitch;
  }

  view(): UnlockView {
    const mode = this.#mode;
    return {
      mode,
      busy: this.#busy,
      error: this.#error,
      prompt: this.#prompt,
      hint: HINTS[mode],
      entered: this.#busy ? this.#submitted : this.#entry.length,
      okEnabled: !this.#busy && this.#entry.length >= MIN_LENGTH,
      pressed: this.#pressed,
      switchLabel: this.#canSwitch && mode !== "pattern" ? (mode === "pin" ? "Use password" : "Use PIN") : null,
      shakeSince: this.#shakeSince,
    };
  }

  press(id: HitId): void {
    if (id === "cancel") {
      this.#entry = "";
      this.#deps.cancel();
      return;
    }
    if (this.#busy) return;
    if (id === "switch") {
      if (this.#canSwitch && this.#mode !== "pattern") this.#setMode(this.#mode === "pin" ? "password" : "pin");
      return;
    }
    if (this.#mode !== "pin") return;
    if (id === "back") this.#entry = this.#entry.slice(0, -1);
    else if (id === "ok") this.#submit();
    else this.#type(id);
  }

  pressDown(id: HitId | null): void {
    this.#pressed = id;
  }

  pressUp(id: HitId | null): void {
    const pressed = this.#pressed;
    this.#pressed = null;
    if (id !== null && id === pressed) this.press(id);
  }

  /** Whether the key was taken, so its default is prevented. */
  key(e: KeyLike): boolean {
    if (e.type !== "keydown") return false;
    if (e.key === "Escape") {
      this.press("cancel");
      return true;
    }
    if (this.#busy) return true;
    if (this.#mode === "pattern") return false;
    if (e.key === "Enter") {
      this.#submit();
      return true;
    }
    if (e.key === "Backspace") {
      this.#entry = this.#entry.slice(0, -1);
      return true;
    }
    const altGr = e.ctrlKey && e.altKey && !e.metaKey;
    if (!altGr && (e.ctrlKey || e.altKey || e.metaKey)) return false;
    if ([...e.key].length !== 1) return false;
    if (this.#mode === "pin" && !/^[0-9]$/.test(e.key)) return true;
    this.#type(e.key);
    return true;
  }

  result(result: UnlockResult): "close" | "stay" {
    this.#busy = false;
    if (result === "unlocked" || result === "unconfirmed") return "close";
    this.#error = true;
    this.#prompt = result === "still-locked" ? "Incorrect. Try again" : "No phone connected";
    this.#shakeSince = result === "still-locked" ? this.#deps.now() : null;
    return "stay";
  }

  #type(text: string): void {
    if (this.#entry.length < MAX_LENGTH[this.#mode]) this.#entry += text;
  }

  #submit(): void {
    if (this.#busy || this.#mode === "pattern" || this.#entry.length < MIN_LENGTH) return;
    const request: UnlockRequest = { kind: this.#mode === "password" ? "password" : "pin", secret: this.#entry };
    this.#submitted = this.#entry.length;
    this.#entry = "";
    this.#busy = true;
    this.#shakeSince = null;
    this.#deps.submit(request);
  }

  #setMode(mode: UnlockMode): void {
    this.#mode = mode;
    this.#entry = "";
    this.#busy = false;
    this.#error = false;
    this.#prompt = PROMPTS[mode];
    this.#pressed = null;
    this.#shakeSince = null;
  }
}
