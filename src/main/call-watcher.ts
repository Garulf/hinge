import type { Adb } from "@yume-chan/adb";
import { incomingCallBody, parseCallState, parseContactName, phoneLookupCommand } from "../shared/calls";
import { runShellChecked, withinTimeout } from "./adb-shell";
import { abortableDelay } from "./abortable-delay";
import type { Notifier, NotifierHandle } from "./notification-mirror";

export interface CallWatcherOpts {
  /** Read at start(), like the notification mirror it shares a setting with. */
  enabled: () => boolean;
  notifier: Notifier;
  isWindowFocused: () => boolean;
  focusWindow: () => void;
  log: (line: string) => void;
  /** Aborting the signal kills the command. */
  runShell?: (adb: Adb, command: string, signal: AbortSignal) => Promise<string>;
  pollMs?: number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_POLL_MS = 1000;
const REGISTRY_COMMAND = "dumpsys telephony.registry";

/**
 * Polls `dumpsys telephony.registry` every pollMs and keeps one PC toast up
 * for as long as the phone rings, closing it once the call is answered,
 * declined or missed. A call that starts ringing while the hinge window is
 * focused gets no toast, since the phone's own call screen is on the mirror.
 * A poll that throws or takes longer than 15 s is logged and leaves the
 * current state alone. Returns a stop function that also closes a toast
 * still showing.
 */
export async function startCallWatcher(adb: Adb, opts: CallWatcherOpts): Promise<() => Promise<void>> {
  if (!opts.enabled()) return async () => {};

  const runShell = (command: string, what: string): Promise<string> =>
    withinTimeout((signal) => (opts.runShell ?? runShellChecked)(adb, command, signal), what);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const wait = opts.delay ?? abortableDelay;
  const controller = new AbortController();

  let ringing = false;
  let toast: NotifierHandle | null = null;
  let stopped = false;

  async function contactName(number: string): Promise<string | null> {
    const command = phoneLookupCommand(number);
    if (!command) return null;
    try {
      return parseContactName(await runShell(command, "the contact lookup"));
    } catch (e) {
      opts.log(`call watcher: contact lookup failed: ${String(e)}`);
      return null;
    }
  }

  async function showIncoming(number: string): Promise<void> {
    const body = incomingCallBody(await contactName(number), number);
    if (stopped || !ringing) return;
    toast = opts.notifier.show({ title: "Incoming call", body, persistent: true });
    toast.onClick(() => opts.focusWindow());
  }

  function closeToast(): void {
    toast?.close();
    toast = null;
  }

  async function tick(): Promise<void> {
    let text: string;
    try {
      text = await runShell(REGISTRY_COMMAND, "the call state poll");
    } catch (e) {
      opts.log(`call watcher: poll failed: ${String(e)}`);
      return;
    }
    const state = parseCallState(text);
    if (state.ringing === ringing) return;
    ringing = state.ringing;
    if (!ringing) closeToast();
    else if (!opts.isWindowFocused()) await showIncoming(state.number);
  }

  const loopDone = (async () => {
    while (!stopped) {
      await tick();
      if (stopped) return;
      await wait(pollMs, controller.signal);
    }
  })();

  return async () => {
    stopped = true;
    controller.abort();
    await loopDone;
    closeToast();
  };
}
