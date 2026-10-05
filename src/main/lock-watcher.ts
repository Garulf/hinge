import type { Adb } from "@yume-chan/adb";
import { CREDENTIAL_COMMAND, KEYGUARD_COMMAND, parseCredential, parseKeyguard, UNLOCKED, type LockState, type UnlockRequest, type UnlockResult } from "../shared/lock";
import type { ControlIntent, MainToRenderer } from "../shared/wire";
import { abortableDelay } from "./abortable-delay";
import { runShellChecked, withinTimeout } from "./adb-shell";
import { samePhone, type ConnectedPhone } from "./app-controller";

export type LockMessage = Extract<MainToRenderer, { kind: "lock-state" | "unlock-result" }>;

export interface LockWatcherDeps {
  post(msg: LockMessage): void;
  /** Input for the phone, over the main session's control channel. */
  control(intent: ControlIntent): void;
  log(line: string): void;
  /** Aborting the signal kills the command. */
  runShell?: (adb: Adb, command: string, signal: AbortSignal) => Promise<string>;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 1000;
export const BOUNCER_SETTLE_MS = 500;
export const ENTER_CHECK_MS = 300;
export const RESULT_POLL_MS = 250;
export const RESULT_LIMIT_MS = 2000;
const KEYCODE_ENTER = 66;
const KEYCODE_WAKEUP = 224;

/**
 * A secure keyguard mirrors as a black screen, so while the renderer reports
 * black this polls whether the keyguard is up, and types the PIN or password
 * the renderer's pad collected into it. The secret only passes through
 * unlock(): it is never logged or kept.
 */
export class LockWatcher {
  readonly #deps: LockWatcherDeps;
  readonly #stopper = new AbortController();
  #phone: ConnectedPhone | null = null;
  #state: LockState = UNLOCKED;
  #black = false;
  #polling: AbortController | null = null;
  #unlocking = false;
  #lastProblem: string | null = null;

  constructor(deps: LockWatcherDeps) {
    this.#deps = deps;
  }

  setPhone(phone: ConnectedPhone | null): void {
    if (samePhone(phone, this.#phone)) return;
    this.#stopPolling();
    this.#phone = phone;
    this.#lastProblem = null;
    this.#state = UNLOCKED;
    this.#post();
    if (phone) void this.#readCredential(phone);
    this.#syncPolling();
  }

  screenBlack(black: boolean): void {
    this.#black = black;
    this.#post();
    this.#syncPolling();
  }

  async unlock(request: UnlockRequest): Promise<void> {
    const phone = this.#phone;
    if (!phone) {
      this.#deps.post({ kind: "unlock-result", result: "unavailable" });
      return;
    }
    if (this.#unlocking) return;
    this.#unlocking = true;
    try {
      const result = await this.#type(phone, request);
      if (this.#phone !== phone) {
        this.#deps.post({ kind: "unlock-result", result: "unavailable" });
        return;
      }
      if (result === "unlocked") this.#setState({ ...this.#state, locked: false });
      this.#deps.post({ kind: "unlock-result", result });
    } finally {
      this.#unlocking = false;
    }
  }

  stop(): void {
    this.#stopper.abort();
    this.#stopPolling();
  }

  async #type(phone: ConnectedPhone, request: UnlockRequest): Promise<UnlockResult> {
    this.#key(KEYCODE_WAKEUP);
    try {
      await this.#shell(phone, "wm dismiss-keyguard", "showing the unlock screen");
    } catch (e) {
      this.#deps.log(`lock watcher: wm dismiss-keyguard failed: ${String(e)}`);
    }
    await this.#wait(BOUNCER_SETTLE_MS);
    if (this.#stopper.signal.aborted) return "unavailable";
    // The pad can be opened by hand on a phone that is not locked: typing then would land in whatever app is in front.
    if ((await this.#readLocked(phone)) === false) return "unlocked";
    if (this.#stopper.signal.aborted) return "unavailable";
    this.#deps.control({ type: "text", text: request.secret });
    await this.#wait(ENTER_CHECK_MS);
    const afterTyping = await this.#readLocked(phone);
    if (afterTyping === false) return "unlocked";
    if (this.#stopper.signal.aborted) return "unavailable";
    this.#key(KEYCODE_ENTER);
    let readable = afterTyping !== null;
    for (let waited = 0; waited < RESULT_LIMIT_MS; waited += RESULT_POLL_MS) {
      await this.#wait(RESULT_POLL_MS);
      if (this.#stopper.signal.aborted) break;
      const locked = await this.#readLocked(phone);
      if (locked === false) return "unlocked";
      if (locked !== null) readable = true;
    }
    return readable ? "still-locked" : "unconfirmed";
  }

  #key(keyCode: number): void {
    this.#deps.control({ type: "key", action: "down", keyCode, repeat: 0, metaState: 0 });
    this.#deps.control({ type: "key", action: "up", keyCode, repeat: 0, metaState: 0 });
  }

  #syncPolling(): void {
    const phone = this.#phone;
    const wanted = this.#black && phone !== null && !this.#stopper.signal.aborted;
    if (!wanted) this.#stopPolling();
    else if (!this.#polling) this.#startPolling(phone);
  }

  #startPolling(phone: ConnectedPhone): void {
    const polling = new AbortController();
    this.#polling = polling;
    void (async () => {
      while (!polling.signal.aborted) {
        await this.#poll(phone);
        if (polling.signal.aborted) return;
        await (this.#deps.delay ?? abortableDelay)(this.#deps.pollMs ?? DEFAULT_POLL_MS, polling.signal);
      }
    })();
  }

  #stopPolling(): void {
    this.#polling?.abort();
    this.#polling = null;
  }

  async #poll(phone: ConnectedPhone): Promise<void> {
    if (this.#unlocking) return;
    const locked = await this.#readLocked(phone);
    if (locked === null || this.#phone !== phone || this.#unlocking) return;
    const newlyLocked = locked && !this.#state.locked;
    this.#setState({ ...this.#state, locked });
    if (newlyLocked) await this.#readCredential(phone);
  }

  /** null when the state could not be read; why is logged once until a read works again. */
  async #readLocked(phone: ConnectedPhone): Promise<boolean | null> {
    let dump: string;
    try {
      dump = await this.#shell(phone, KEYGUARD_COMMAND, "the keyguard poll");
    } catch (e) {
      this.#problem(`lock watcher: keyguard poll failed: ${String(e)}`);
      return null;
    }
    const locked = parseKeyguard(dump);
    if (locked === null) this.#problem("lock watcher: no keyguard state in dumpsys activity activities");
    else this.#lastProblem = null;
    return locked;
  }

  async #readCredential(phone: ConnectedPhone): Promise<void> {
    try {
      const credential = parseCredential(await this.#shell(phone, CREDENTIAL_COMMAND, "the lock type read"));
      if (this.#phone === phone) this.#setState({ ...this.#state, credential });
    } catch (e) {
      this.#deps.log(`lock watcher: reading the lock type failed: ${String(e)}`);
    }
  }

  #shell(phone: ConnectedPhone, command: string, what: string): Promise<string> {
    return withinTimeout((signal) => (this.#deps.runShell ?? runShellChecked)(phone.adb, command, signal), what);
  }

  #wait(ms: number): Promise<void> {
    return (this.#deps.delay ?? abortableDelay)(ms, this.#stopper.signal);
  }

  #problem(line: string): void {
    if (line === this.#lastProblem) return;
    this.#lastProblem = line;
    this.#deps.log(line);
  }

  #setState(next: LockState): void {
    if (next.locked === this.#state.locked && next.credential === this.#state.credential) return;
    this.#state = next;
    this.#post();
  }

  #post(): void {
    this.#deps.post({ kind: "lock-state", state: this.#state });
  }
}
