import type { Timers } from "../shared/popout";
import type { ConnectedPhone } from "./app-controller";
import type { AudioSink } from "./audio-forward";

export const COMPANION_RESTART_DELAYS_MS = [1000, 2000, 4000, 8000];

export interface CompanionLike {
  start(sink: AudioSink): Promise<void>;
  stop(): Promise<void>;
  readonly ended: Promise<void>;
  beginPush(content: string): bigint;
}

export interface CompanionOwnerDeps {
  create(phone: ConnectedPhone): CompanionLike;
  sink: AudioSink;
  log?: (line: string) => void;
  timers?: Timers;
}

const globalTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};

function samePhone(a: ConnectedPhone | null, b: ConnectedPhone | null): boolean {
  return a === b || (a !== null && b !== null && a.adb === b.adb && a.deviceId === b.deviceId);
}

/**
 * Keeps one companion session running for the connected phone while the
 * phone is shown anywhere (the main window or a pop-out), and starts a new
 * one, after a growing delay, whenever it ends on its own.
 */
export class CompanionOwner {
  readonly #deps: CompanionOwnerDeps;
  readonly #timers: Timers;
  #phone: ConnectedPhone | null = null;
  #wanted = false;
  #stopped = false;
  #current: CompanionLike | null = null;
  #restart: ReturnType<Timers["set"]> | null = null;
  #restarts = 0;

  constructor(deps: CompanionOwnerDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? globalTimers;
  }

  phone(phone: ConnectedPhone | null): void {
    if (samePhone(this.#phone, phone)) return;
    this.#phone = phone;
    this.#restarts = 0;
    this.#halt();
    this.#reconcile();
  }

  wanted(on: boolean): void {
    if (this.#wanted === on) return;
    this.#wanted = on;
    this.#reconcile();
  }

  beginPush(content: string): bigint {
    return this.#current?.beginPush(content) ?? 0n;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#halt();
  }

  #reconcile(): void {
    if (this.#stopped || !this.#phone || !this.#wanted) {
      void this.#halt();
      return;
    }
    if (!this.#current && this.#restart === null) this.#launch(this.#phone);
  }

  #launch(phone: ConnectedPhone): void {
    const companion = this.#deps.create(phone);
    this.#current = companion;
    void companion.ended.then(() => this.#onEnded(companion));
    void companion.start(this.#deps.sink);
  }

  #onEnded(companion: CompanionLike): void {
    if (this.#current !== companion) return;
    this.#current = null;
    const delay = COMPANION_RESTART_DELAYS_MS[Math.min(this.#restarts, COMPANION_RESTART_DELAYS_MS.length - 1)];
    this.#restarts++;
    this.#deps.log?.(`companion session ended; restarting in ${delay / 1000}s`);
    this.#restart = this.#timers.set(() => {
      this.#restart = null;
      this.#reconcile();
    }, delay);
  }

  async #halt(): Promise<void> {
    if (this.#restart !== null) this.#timers.clear(this.#restart);
    this.#restart = null;
    const current = this.#current;
    this.#current = null;
    await current?.stop().catch((e) => this.#deps.log?.(`companion session failed to stop: ${String(e)}`));
  }
}
