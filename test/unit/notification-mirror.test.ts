import { expect, test, vi } from "vitest";
import { startNotificationMirror, type Notifier } from "../../src/main/notification-mirror";

function fakeAdb(): unknown {
  return { marker: "adb" };
}

function fakeNotifier(): { notifier: Notifier; shown: { title: string; body: string }[]; clickHandlers: (() => void)[] } {
  const shown: { title: string; body: string }[] = [];
  const clickHandlers: (() => void)[] = [];
  const notifier: Notifier = {
    show(input) {
      shown.push(input);
      return {
        onClick(cb) {
          clickHandlers.push(cb);
        },
      };
    },
  };
  return { notifier, shown, clickHandlers };
}

function fakeDelay(ms: number, signal: AbortSignal): Promise<void> {
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

function scriptedShell(responses: string[]): { runShell: (adb: unknown, command: string) => Promise<string>; commands: string[] } {
  const commands: string[] = [];
  let i = 0;
  return {
    commands,
    runShell: async (_adb, command) => {
      commands.push(command);
      const next = responses[Math.min(i, responses.length - 1)];
      i++;
      return next;
    },
  };
}

const CHAT_MESSAGE = [
  "  NotificationRecord(0x1: pkg=com.example.chat user=UserHandle{0} id=1 tag=null key=0|com.example.chat|1|null|10201: Notification(flags=0x10))",
  "    pkg=com.example.chat",
  "    key=0|com.example.chat|1|null|10201",
  "    importance=3",
  "    postTime=1000",
  "    flags=0x10",
  "    extras={",
  "      android.title=Alex",
  "      android.text=hi",
  "    }",
].join("\n");

function withMessage(postTime: number): string {
  return CHAT_MESSAGE.replace("postTime=1000", `postTime=${postTime}`);
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("the first poll only seeds: no notification is shown even though the phone already has one", async () => {
  vi.useFakeTimers();
  const { runShell, commands } = scriptedShell([withMessage(1000)]);
  const { notifier, shown } = fakeNotifier();
  const stop = await startNotificationMirror(fakeAdb() as never, {
    enabled: () => true,
    notifier,
    isWindowFocused: () => false,
    focusWindow: () => {},
    launchApp: async () => {},
    log: () => {},
    runShell,
    pollMs: 2000,
    delay: fakeDelay,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toEqual(["dumpsys notification --noredact"]);
  expect(shown).toEqual([]);
  await stop();
  vi.useRealTimers();
});

test("a notification new on the second poll is shown, a repeat is not, a repost with a newer postTime is shown again", async () => {
  vi.useFakeTimers();
  const empty = "Current Notification Manager state:\n  Notification List:\n";
  const { runShell } = scriptedShell([empty, withMessage(1000), withMessage(1000), withMessage(1500)]);
  const { notifier, shown } = fakeNotifier();
  const stop = await startNotificationMirror(fakeAdb() as never, {
    enabled: () => true,
    notifier,
    isWindowFocused: () => false,
    focusWindow: () => {},
    launchApp: async () => {},
    log: () => {},
    runShell,
    pollMs: 2000,
    delay: fakeDelay,
  });
  await vi.advanceTimersByTimeAsync(0); // seed: empty tray
  expect(shown).toEqual([]);
  await vi.advanceTimersByTimeAsync(2000); // new key
  expect(shown).toHaveLength(1);
  expect(shown[0]).toEqual({ title: "Alex", body: "hi" });
  await vi.advanceTimersByTimeAsync(2000); // same key, same postTime
  expect(shown).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2000); // reposted with a newer postTime
  expect(shown).toHaveLength(2);
  await stop();
  vi.useRealTimers();
});

test("no PC notification pops while the hinge window is focused", async () => {
  vi.useFakeTimers();
  const empty = "Current Notification Manager state:\n  Notification List:\n";
  const { runShell } = scriptedShell([empty, withMessage(1000)]);
  const { notifier, shown } = fakeNotifier();
  const stop = await startNotificationMirror(fakeAdb() as never, {
    enabled: () => true,
    notifier,
    isWindowFocused: () => true,
    focusWindow: () => {},
    launchApp: async () => {},
    log: () => {},
    runShell,
    pollMs: 2000,
    delay: fakeDelay,
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(shown).toEqual([]);
  await stop();
  vi.useRealTimers();
});

test("clicking a mirrored notification focuses the window and launches its app on the phone", async () => {
  vi.useFakeTimers();
  const empty = "Current Notification Manager state:\n  Notification List:\n";
  const { runShell } = scriptedShell([empty, withMessage(1000)]);
  const { notifier, clickHandlers } = fakeNotifier();
  let focused = false;
  const launched: string[] = [];
  const stop = await startNotificationMirror(fakeAdb() as never, {
    enabled: () => true,
    notifier,
    isWindowFocused: () => false,
    focusWindow: () => {
      focused = true;
    },
    launchApp: async (pkg) => {
      launched.push(pkg);
    },
    log: () => {},
    runShell,
    pollMs: 2000,
    delay: fakeDelay,
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(clickHandlers).toHaveLength(1);
  clickHandlers[0]();
  await tick();
  expect(focused).toBe(true);
  expect(launched).toEqual(["com.example.chat"]);
  await stop();
  vi.useRealTimers();
});

test("a poll failure is logged and the next tick retries, without clearing the known set", async () => {
  vi.useFakeTimers();
  const empty = "Current Notification Manager state:\n  Notification List:\n";
  const commands: string[] = [];
  let call = 0;
  const runShell = async (_adb: unknown, command: string) => {
    commands.push(command);
    call++;
    if (call === 1) return empty;
    if (call === 2) return withMessage(1000);
    if (call === 3) throw new Error("adb hiccup");
    return withMessage(1000);
  };
  const logs: string[] = [];
  const { notifier, shown } = fakeNotifier();
  const stop = await startNotificationMirror(fakeAdb() as never, {
    enabled: () => true,
    notifier,
    isWindowFocused: () => false,
    focusWindow: () => {},
    launchApp: async () => {},
    log: (line) => logs.push(line),
    runShell,
    pollMs: 2000,
    delay: fakeDelay,
  });
  await vi.advanceTimersByTimeAsync(0); // seed
  await vi.advanceTimersByTimeAsync(2000); // new key shown
  expect(shown).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2000); // poll throws
  expect(logs.some((l) => l.includes("adb hiccup"))).toBe(true);
  await vi.advanceTimersByTimeAsync(2000); // same postTime again: not re-shown
  expect(shown).toHaveLength(1);
  await stop();
  vi.useRealTimers();
});

test("stop() ends the polling loop", async () => {
  vi.useFakeTimers();
  const { runShell, commands } = scriptedShell(["Current Notification Manager state:\n  Notification List:\n"]);
  const stop = await startNotificationMirror(fakeAdb() as never, {
    enabled: () => true,
    notifier: fakeNotifier().notifier,
    isWindowFocused: () => false,
    focusWindow: () => {},
    launchApp: async () => {},
    log: () => {},
    runShell,
    pollMs: 2000,
    delay: fakeDelay,
  });
  await vi.advanceTimersByTimeAsync(0);
  await stop();
  const countAtStop = commands.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(commands.length).toBe(countAtStop);
  vi.useRealTimers();
});

test("disabled by the setting: no shell command is ever run and stop resolves immediately", async () => {
  const { runShell, commands } = scriptedShell(["irrelevant"]);
  const stop = await startNotificationMirror(fakeAdb() as never, {
    enabled: () => false,
    notifier: fakeNotifier().notifier,
    isWindowFocused: () => false,
    focusWindow: () => {},
    launchApp: async () => {},
    log: () => {},
    runShell,
  });
  await stop();
  expect(commands).toEqual([]);
});
