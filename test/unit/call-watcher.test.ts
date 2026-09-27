import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startCallWatcher } from "../../src/main/call-watcher";
import type { Notifier, NotifierInput } from "../../src/main/notification-mirror";

// Built from AOSP's TelephonyRegistry.dump() layout, not captured from the Fold 7: unverified against Samsung's build.
const RINGING = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-telephony-registry-ringing-aosp.txt"), "utf8");
const IDLE = RINGING.replace("mCallState=1", "mCallState=0").replace("mCallIncomingNumber=+15551234567", "mCallIncomingNumber=");
const OFFHOOK = RINGING.replace("mCallState=1", "mCallState=2");
const ALEX = "Row: 0 display_name=Alex Doe\n";

afterEach(() => {
  vi.useRealTimers();
});

interface ShownToast {
  input: NotifierInput;
  closed: boolean;
  click: () => void;
}

function fakeNotifier(): { notifier: Notifier; shown: ShownToast[] } {
  const shown: ShownToast[] = [];
  const notifier: Notifier = {
    show(input) {
      const toast: ShownToast = { input, closed: false, click: () => {} };
      shown.push(toast);
      return {
        onClick(cb) {
          toast.click = cb;
        },
        close() {
          toast.closed = true;
        },
      };
    },
  };
  return { notifier, shown };
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

/** Answers each registry poll with the next state in `states` (the last one repeats) and every contact lookup with `contact`. */
function scriptedPhone(states: string[], contact: () => string = () => ALEX) {
  const commands: string[] = [];
  let poll = 0;
  return {
    commands,
    runShell: async (_adb: unknown, command: string) => {
      commands.push(command);
      if (command.startsWith("content query")) return contact();
      return states[Math.min(poll++, states.length - 1)];
    },
  };
}

async function watch(
  phone: ReturnType<typeof scriptedPhone>,
  overrides: Partial<Parameters<typeof startCallWatcher>[1]> = {},
) {
  const { notifier, shown } = fakeNotifier();
  const logs: string[] = [];
  const stop = await startCallWatcher({} as never, {
    enabled: () => true,
    notifier,
    isWindowFocused: () => false,
    focusWindow: () => {},
    log: (line) => logs.push(line),
    runShell: phone.runShell,
    pollMs: 1000,
    delay: fakeDelay,
    ...overrides,
  });
  return { stop, shown, logs };
}

test("a ringing phone pops one persistent toast naming the contact, however many polls it keeps ringing", async () => {
  vi.useFakeTimers();
  const phone = scriptedPhone([IDLE, RINGING]);
  const { stop, shown } = await watch(phone);
  await vi.advanceTimersByTimeAsync(0);
  expect(shown).toEqual([]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(shown).toHaveLength(1);
  expect(shown[0].input).toEqual({ title: "Incoming call", body: "Alex Doe", persistent: true });
  expect(phone.commands).toContain(
    "content query --uri 'content://com.android.contacts/phone_lookup/%2B15551234567' --projection display_name",
  );
  await stop();
});

test("the toast closes when the call is answered", async () => {
  vi.useFakeTimers();
  const { stop, shown } = await watch(scriptedPhone([RINGING, OFFHOOK]));
  await vi.advanceTimersByTimeAsync(0);
  expect(shown[0].closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(shown[0].closed).toBe(true);
  await stop();
});

test("a second call after the first ended gets its own toast", async () => {
  vi.useFakeTimers();
  const { stop, shown } = await watch(scriptedPhone([RINGING, IDLE, RINGING]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(shown).toHaveLength(2);
  expect(shown[0].closed).toBe(true);
  expect(shown[1].closed).toBe(false);
  await stop();
});

test("a caller who is not a contact is shown by number", async () => {
  vi.useFakeTimers();
  const { stop, shown } = await watch(scriptedPhone([RINGING], () => "No result found.\n"));
  await vi.advanceTimersByTimeAsync(0);
  expect(shown[0].input.body).toBe("+15551234567");
  await stop();
});

test("a failed contact lookup is logged and the toast falls back to the number", async () => {
  vi.useFakeTimers();
  const phone = scriptedPhone([RINGING], () => {
    throw new Error("permission denied");
  });
  const { stop, shown, logs } = await watch(phone);
  await vi.advanceTimersByTimeAsync(0);
  expect(shown[0].input.body).toBe("+15551234567");
  expect(logs.some((l) => l.includes("permission denied"))).toBe(true);
  await stop();
});

test("no toast while the hinge window is focused, and none later for the same call", async () => {
  vi.useFakeTimers();
  let focused = true;
  const { stop, shown } = await watch(scriptedPhone([RINGING]), { isWindowFocused: () => focused });
  await vi.advanceTimersByTimeAsync(0);
  focused = false;
  await vi.advanceTimersByTimeAsync(2000);
  expect(shown).toEqual([]);
  await stop();
});

test("clicking the toast focuses the hinge window", async () => {
  vi.useFakeTimers();
  let focusedCount = 0;
  const { stop, shown } = await watch(scriptedPhone([RINGING]), { focusWindow: () => focusedCount++ });
  await vi.advanceTimersByTimeAsync(0);
  shown[0].click();
  expect(focusedCount).toBe(1);
  await stop();
});

test("a failed poll is logged and leaves the toast up", async () => {
  vi.useFakeTimers();
  let poll = 0;
  const { stop, shown, logs } = await watch(scriptedPhone([]), {
    runShell: async (_adb, command) => {
      if (command.startsWith("content query")) return ALEX;
      if (poll++ === 1) throw new Error("adb hiccup");
      return RINGING;
    },
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(logs.some((l) => l.includes("adb hiccup"))).toBe(true);
  expect(shown).toHaveLength(1);
  expect(shown[0].closed).toBe(false);
  await stop();
});

test("stop() ends polling and closes a toast still up", async () => {
  vi.useFakeTimers();
  const phone = scriptedPhone([RINGING]);
  const { stop, shown } = await watch(phone);
  await vi.advanceTimersByTimeAsync(0);
  await stop();
  expect(shown[0].closed).toBe(true);
  const countAtStop = phone.commands.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(phone.commands.length).toBe(countAtStop);
});

test("a toast whose contact lookup finishes after stop() is never shown", async () => {
  vi.useFakeTimers();
  let answerLookup: (text: string) => void = () => {};
  const { stop, shown } = await watch(scriptedPhone([]), {
    runShell: (_adb, command) =>
      command.startsWith("content query") ? new Promise((resolve) => (answerLookup = resolve)) : Promise.resolve(RINGING),
  });
  await vi.advanceTimersByTimeAsync(0);
  const stopped = stop();
  answerLookup(ALEX);
  await stopped;
  expect(shown).toEqual([]);
});

test("disabled by the setting: no shell command is ever run", async () => {
  const phone = scriptedPhone([RINGING]);
  const { stop } = await watch(phone, { enabled: () => false });
  await stop();
  expect(phone.commands).toEqual([]);
});

test("a poll the phone never answers is given up after 15 s, its command killed, and polling carries on", async () => {
  vi.useFakeTimers();
  const signals: (AbortSignal | undefined)[] = [];
  let poll = 0;
  const { stop, shown, logs } = await watch(scriptedPhone([]), {
    runShell: (_adb, command, signal) => {
      if (command.startsWith("content query")) return Promise.resolve(ALEX);
      signals.push(signal);
      return poll++ === 0 ? new Promise<string>(() => {}) : Promise.resolve(RINGING);
    },
  });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(poll).toBe(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(signals[0]?.aborted).toBe(true);
  expect(logs.some((l) => l.includes("timed out"))).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(poll).toBe(2);
  expect(shown).toHaveLength(1);
  await stop();
});

test("a contact lookup the phone never answers is given up after 15 s and the toast shows the number", async () => {
  vi.useFakeTimers();
  const { stop, shown, logs } = await watch(scriptedPhone([RINGING], () => ""), {
    runShell: (_adb, command) => (command.startsWith("content query") ? new Promise<string>(() => {}) : Promise.resolve(RINGING)),
  });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(shown).toEqual([]);

  await vi.advanceTimersByTimeAsync(1);
  expect(shown[0].input.body).toBe("+15551234567");
  expect(logs.some((l) => l.includes("timed out"))).toBe(true);
  await stop();
});
