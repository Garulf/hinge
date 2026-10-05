import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LockWatcher, type LockMessage } from "../../src/main/lock-watcher";
import type { ConnectedPhone } from "../../src/main/app-controller";
import { abortableDelay } from "../../src/main/abortable-delay";
import type { ControlIntent } from "../../src/shared/wire";

// Modelled on AOSP's dumps, not captured from the Fold 7: unverified against One UI.
const LOCKED = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-keyguard-aosp.txt"), "utf8");
const UNLOCKED = LOCKED.replace("mKeyguardShowing=true", "mKeyguardShowing=false");
const LOCK_SETTINGS = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-lock-settings-aosp.txt"), "utf8");
const PASSWORD_SETTINGS = LOCK_SETTINGS.replace("CredentialType: Pin", "CredentialType: Password");

const BOUNCE_AND_CHECK = 500 + 300 + 10;

const PHONE: ConnectedPhone = { adb: {} as never, serial: "R5CY", deviceId: "R5CY", model: "SM-F966B" };
const OTHER: ConnectedPhone = { adb: {} as never, serial: "X1", deviceId: "X1", model: null };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** keyguard() answers each keyguard read; a thrown Error makes that command fail. */
function scriptedPhone(keyguard: () => string, lockSettings: () => string = () => LOCK_SETTINGS) {
  const commands: string[] = [];
  return {
    commands,
    keyguardReads: () => commands.filter((c) => c.startsWith("dumpsys activity")).length,
    runShell: async (_adb: unknown, command: string) => {
      commands.push(command);
      if (command.startsWith("dumpsys activity")) return keyguard();
      if (command === "dumpsys lock_settings") return lockSettings();
      return "";
    },
  };
}

function watcher(phone: ReturnType<typeof scriptedPhone>) {
  const posted: LockMessage[] = [];
  const sent: ControlIntent[] = [];
  const logs: string[] = [];
  const w = new LockWatcher({ post: (m) => posted.push(m), control: (i) => sent.push(i), log: (l) => logs.push(l), runShell: phone.runShell, delay: abortableDelay });
  return { w, posted, sent, logs, states: () => posted.filter((m) => m.kind === "lock-state").map((m) => m.kind === "lock-state" && m.state) };
}

const keys = (sent: ControlIntent[]) => sent.map((i) => (i.type === "key" ? `${i.action}:${i.keyCode}` : i.type === "text" ? `text:${i.text}` : i.type));

test("an unlocked phone is polled only while the screen is black", async () => {
  const phone = scriptedPhone(() => UNLOCKED);
  const { w } = watcher(phone);
  w.setPhone(PHONE);
  await vi.advanceTimersByTimeAsync(5000);
  expect(phone.keyguardReads()).toBe(0);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(2500);
  expect(phone.keyguardReads()).toBe(3);
  w.screenBlack(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(phone.keyguardReads()).toBe(3);
  w.stop();
});

test("a phone unlocked by hand after the screen lit up is still seen, and polling then stops", async () => {
  let keyguard = LOCKED;
  const phone = scriptedPhone(() => keyguard);
  const { w, states } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(states().at(-1)).toEqual({ locked: true, credential: "pin" });
  w.screenBlack(false);
  await vi.advanceTimersByTimeAsync(300);
  keyguard = UNLOCKED;
  await vi.advanceTimersByTimeAsync(1500);
  expect(states().at(-1)).toEqual({ locked: false, credential: "pin" });
  const reads = phone.keyguardReads();
  await vi.advanceTimersByTimeAsync(5000);
  expect(phone.keyguardReads()).toBe(reads);
  w.stop();
});

test("a keyguard coming up is posted with the phone's lock type", async () => {
  const phone = scriptedPhone(() => LOCKED);
  const { w, states } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(states().at(-1)).toEqual({ locked: true, credential: "pin" });
  w.stop();
});

test("the lock type is read again on every lock", async () => {
  let keyguard = LOCKED;
  let settings = LOCK_SETTINGS;
  const phone = scriptedPhone(() => keyguard, () => settings);
  const { w, states } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(10);
  keyguard = UNLOCKED;
  await vi.advanceTimersByTimeAsync(1000);
  settings = PASSWORD_SETTINGS;
  keyguard = LOCKED;
  await vi.advanceTimersByTimeAsync(1000);
  expect(states().at(-1)).toEqual({ locked: true, credential: "password" });
  w.stop();
});

test("screenBlack re-posts the current state, so a reloaded renderer hears it", async () => {
  const phone = scriptedPhone(() => LOCKED);
  const { w, posted } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(10);
  const before = posted.length;
  w.screenBlack(true);
  expect(posted.slice(before)).toEqual([{ kind: "lock-state", state: { locked: true, credential: "pin" } }]);
  w.stop();
});

test("a failing or unreadable poll leaves the state alone and is logged once until a read works", async () => {
  let answer: () => string = () => LOCKED;
  const phone = scriptedPhone(() => answer());
  const { w, logs, states } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(10);
  answer = () => {
    throw new Error("exited with 1: boom");
  };
  await vi.advanceTimersByTimeAsync(3000);
  answer = () => "  KeyguardController:\n";
  await vi.advanceTimersByTimeAsync(3000);
  expect(states().at(-1)).toEqual({ locked: true, credential: "pin" });
  expect(logs.filter((l) => l.includes("keyguard poll failed"))).toHaveLength(1);
  expect(logs.filter((l) => l.includes("no keyguard state"))).toHaveLength(1);
  w.stop();
});

test("another phone, or none, resets to unlocked and stops the old phone's polling", async () => {
  const phone = scriptedPhone(() => LOCKED);
  const { w, states } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(10);
  w.setPhone(null);
  expect(states().at(-1)).toEqual({ locked: false, credential: "unknown" });
  const reads = phone.keyguardReads();
  await vi.advanceTimersByTimeAsync(5000);
  expect(phone.keyguardReads()).toBe(reads);
  w.setPhone(OTHER);
  await vi.advanceTimersByTimeAsync(10);
  expect(states().at(-1)).toEqual({ locked: true, credential: "pin" });
  w.stop();
});

test("unlock wakes the phone, shows the bouncer, types the PIN, sends Enter when still locked and answers unlocked", async () => {
  let keyguard = LOCKED;
  const phone = scriptedPhone(() => keyguard);
  const { w, sent, posted } = watcher(phone);
  w.setPhone(PHONE);
  const done = w.unlock({ kind: "pin", secret: "1234" });
  await vi.advanceTimersByTimeAsync(BOUNCE_AND_CHECK);
  keyguard = UNLOCKED;
  await vi.advanceTimersByTimeAsync(300);
  await done;
  expect(keys(sent)).toEqual(["down:224", "up:224", "text:1234", "down:66", "up:66"]);
  expect(phone.commands).toContain("wm dismiss-keyguard");
  expect(posted.slice(-2)).toEqual([
    { kind: "lock-state", state: { locked: false, credential: "pin" } },
    { kind: "unlock-result", result: "unlocked" },
  ]);
});

test("a PIN the phone confirmed by itself gets no Enter", async () => {
  let keyguard = LOCKED;
  const phone = scriptedPhone(() => keyguard);
  const { w, sent, posted } = watcher(phone);
  w.setPhone(PHONE);
  const done = w.unlock({ kind: "pin", secret: "1234" });
  await vi.advanceTimersByTimeAsync(500);
  keyguard = UNLOCKED;
  await vi.advanceTimersByTimeAsync(600);
  await done;
  expect(keys(sent)).toEqual(["down:224", "up:224", "text:1234"]);
  expect(posted.at(-1)).toEqual({ kind: "unlock-result", result: "unlocked" });
});

test("still locked after 2 s answers still-locked, keeps the state locked, and polls stay quiet meanwhile", async () => {
  const phone = scriptedPhone(() => LOCKED);
  const { w, posted } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(10);
  const before = posted.length;
  const done = w.unlock({ kind: "password", secret: "hunter22" });
  await vi.advanceTimersByTimeAsync(3000);
  await done;
  w.stop();
  expect(posted.slice(before)).toEqual([{ kind: "unlock-result", result: "still-locked" }]);
});

test("an unreadable keyguard answers unconfirmed rather than still-locked", async () => {
  const phone = scriptedPhone(() => "");
  const { w, posted, sent } = watcher(phone);
  w.setPhone(PHONE);
  const done = w.unlock({ kind: "pin", secret: "1234" });
  await vi.advanceTimersByTimeAsync(3000);
  await done;
  expect(keys(sent)).toContain("down:66");
  expect(posted.at(-1)).toEqual({ kind: "unlock-result", result: "unconfirmed" });
});

test("with no phone, unlock answers unavailable and sends nothing", async () => {
  const { w, posted, sent } = watcher(scriptedPhone(() => LOCKED));
  await w.unlock({ kind: "pin", secret: "1234" });
  expect(posted).toEqual([{ kind: "unlock-result", result: "unavailable" }]);
  expect(sent).toEqual([]);
});

test("the secret never reaches the log, even when every command fails", async () => {
  const phone = scriptedPhone(() => {
    throw new Error("exited with 255: device offline");
  });
  phone.runShell = async (_adb, command) => {
    phone.commands.push(command);
    throw new Error(`exited with 255: device offline (${command})`);
  };
  const { w, logs } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  const done = w.unlock({ kind: "password", secret: "s3cret-pass" });
  await vi.advanceTimersByTimeAsync(5000);
  await done;
  w.stop();
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.join("\n")).not.toContain("s3cret-pass");
});

test("a phone that is already unlocked gets the wakeup but no PIN and no Enter", async () => {
  const phone = scriptedPhone(() => UNLOCKED);
  const { w, sent, posted } = watcher(phone);
  w.setPhone(PHONE);
  const done = w.unlock({ kind: "pin", secret: "1234" });
  await vi.advanceTimersByTimeAsync(3000);
  await done;
  expect(keys(sent)).toEqual(["down:224", "up:224"]);
  expect(posted.at(-1)).toEqual({ kind: "unlock-result", result: "unlocked" });
});

test("stopping while the bouncer settles types nothing", async () => {
  const phone = scriptedPhone(() => LOCKED);
  const { w, sent } = watcher(phone);
  w.setPhone(PHONE);
  const done = w.unlock({ kind: "pin", secret: "1234" });
  await vi.advanceTimersByTimeAsync(100);
  w.stop();
  await vi.advanceTimersByTimeAsync(3000);
  await done;
  expect(keys(sent)).toEqual(["down:224", "up:224"]);
});

test("quick screenBlack toggles in one tick leave a single poll loop, one read per second", async () => {
  const phone = scriptedPhone(() => LOCKED);
  const { w } = watcher(phone);
  w.setPhone(PHONE);
  w.screenBlack(true);
  w.screenBlack(false);
  w.screenBlack(true);
  await vi.advanceTimersByTimeAsync(2500);
  const afterToggles = phone.keyguardReads();
  await vi.advanceTimersByTimeAsync(2000);
  expect(phone.keyguardReads() - afterToggles).toBe(2);
  w.stop();
});

test("switching to another phone while the bouncer settles types nothing into it", async () => {
  const phone = scriptedPhone(() => LOCKED);
  const { w, sent } = watcher(phone);
  w.setPhone(PHONE);
  const done = w.unlock({ kind: "pin", secret: "1234" });
  await vi.advanceTimersByTimeAsync(100);
  w.setPhone(OTHER);
  await vi.advanceTimersByTimeAsync(3000);
  await done;
  expect(keys(sent)).toEqual(["down:224", "up:224"]);
  w.stop();
});
