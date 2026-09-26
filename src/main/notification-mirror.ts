import type { Adb } from "@yume-chan/adb";
import { diffNotifications, isMirrorable, parseNotifications, type NotificationRecord } from "../shared/notifications";
import { runShellText } from "./adb-shell";

export interface NotifierHandle {
  onClick(cb: () => void): void;
}

/** A PC-side notification popup; the real implementation wraps Electron's Notification. */
export interface Notifier {
  show(input: { title: string; body: string }): NotifierHandle;
}

export interface NotificationMirrorOpts {
  /** Read at start(): a phone that connects while the setting is off never polls, matching how the other stream settings apply on the next connection. */
  enabled: () => boolean;
  notifier: Notifier;
  isWindowFocused: () => boolean;
  focusWindow: () => void;
  launchApp: (pkg: string) => Promise<void>;
  log: (line: string) => void;
  runShell?: (adb: Adb, command: string) => Promise<string>;
  pollMs?: number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_POLL_MS = 2000;
const DUMPSYS_COMMAND = "dumpsys notification --noredact";

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Polls `dumpsys notification --noredact` every pollMs and mirrors any new
 * or reposted notification (see shared/notifications.ts for the diff and
 * skip rules) as a PC notification, unless the hinge window is focused. A
 * poll that throws (an adb hiccup or timeout) is logged and retried on the
 * next tick without touching the known set. Returns a stop function; when
 * the setting is off, start() does nothing and stop() resolves at once.
 */
export async function startNotificationMirror(adb: Adb, opts: NotificationMirrorOpts): Promise<() => Promise<void>> {
  if (!opts.enabled()) return async () => {};

  const runShell = opts.runShell ?? runShellText;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const wait = opts.delay ?? defaultDelay;
  const controller = new AbortController();

  let known = new Map<string, number>();
  let seeded = false;
  let stopped = false;

  function show(record: NotificationRecord): void {
    if (opts.isWindowFocused()) return;
    const handle = opts.notifier.show({ title: record.title || record.pkg, body: record.text });
    handle.onClick(() => {
      opts.focusWindow();
      opts.launchApp(record.pkg).catch((e) => opts.log(`notification mirror: could not launch ${record.pkg}: ${String(e)}`));
    });
  }

  async function tick(): Promise<void> {
    let text: string;
    try {
      text = await runShell(adb, DUMPSYS_COMMAND);
    } catch (e) {
      opts.log(`notification mirror: poll failed: ${String(e)}`);
      return;
    }
    const records = parseNotifications(text).filter(isMirrorable);
    const diff = diffNotifications(known, records, seeded);
    known = diff.known;
    seeded = true;
    for (const record of diff.toShow) show(record);
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
  };
}
