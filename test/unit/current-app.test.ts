import { expect, test } from "vitest";
import type { ConnectedPhone } from "../../src/main/app-controller";
import { dumpActivities, landedOnPhoneScreen, popOutCurrent, STAY_CHECK_MS, type CurrentAppDeps } from "../../src/main/current-app";
import type { OpenResult } from "../../src/main/popout-manager";

const PHONE: ConnectedPhone = { adb: {} as never, serial: "R5CY-serial", deviceId: "R5CY", model: "SM-F966B" };

function dump(displays: Record<number, string>): string {
  return Object.entries(displays)
    .map(([id, pkg]) => `Display #${id} (activities from top to bottom):\n    mResumedActivity: ActivityRecord{abc u0 ${pkg}/.Main t7}`)
    .join("\n\n");
}

function harness(o: { dumps: (string | Error)[]; phone?: ConnectedPhone | null; open?: OpenResult; streams?: boolean; label?: string | null }) {
  const calls: string[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const dumps = [...o.dumps];
  const deps: CurrentAppDeps = {
    phone: () => (o.phone === undefined ? PHONE : o.phone),
    dumpActivities: async () => {
      calls.push("dump");
      const next = dumps.shift();
      if (next === undefined) throw new Error("no more dumps");
      if (next instanceof Error) throw next;
      return next;
    },
    popouts: {
      open: (pkg) => {
        calls.push(`open ${pkg}`);
        return o.open ?? "opened";
      },
      whenStreaming: async (pkg) => {
        calls.push(`streaming ${pkg}`);
        return o.streams ?? true;
      },
      label: () => (o.label === undefined ? "Chat" : o.label),
    },
    notice: (text) => notices.push(text),
    log: (line) => logs.push(line),
    wait: async (ms) => void calls.push(`wait ${ms}`),
  };
  return { deps, calls, notices, logs };
}

test("the phone screen's app is popped out, and once it streams and has had 3 s to move, a phone screen still showing it gets a notice", async () => {
  const { deps, calls, notices } = harness({ dumps: [dump({ 0: "com.example.chat" }), dump({ 0: "com.example.chat" })] });
  await popOutCurrent(deps);

  expect(STAY_CHECK_MS).toBe(3000);
  expect(calls).toEqual(["dump", "open com.example.chat", "streaming com.example.chat", "wait 3000", "dump"]);
  expect(notices).toEqual(["Chat stayed on the phone screen"]);
});

test("an app that moved to its own display gets no notice", async () => {
  const { deps, notices } = harness({ dumps: [dump({ 0: "com.example.chat" }), dump({ 0: "com.android.launcher3", 2: "com.example.chat" })] });
  await popOutCurrent(deps);
  expect(notices).toEqual([]);
});

test("the launcher or System UI on the phone screen means there is nothing to pop out", async () => {
  for (const pkg of ["com.android.systemui", "com.sec.android.app.launcher"]) {
    const { deps, calls, notices } = harness({ dumps: [dump({ 0: pkg })] });
    await popOutCurrent(deps);
    expect(calls).toEqual(["dump"]);
    expect(notices).toEqual(["Nothing to pop out"]);
  }
});

test("with no phone nothing is read and the notice says so", async () => {
  const { deps, calls, notices } = harness({ dumps: [], phone: null });
  await popOutCurrent(deps);
  expect(calls).toEqual([]);
  expect(notices).toEqual(["No phone connected"]);
});

test("a failed dump is logged and noticed, and nothing opens", async () => {
  const { deps, calls, notices, logs } = harness({ dumps: [new Error("the activities dump timed out after 15000 ms")] });
  await popOutCurrent(deps);
  expect(calls).toEqual(["dump"]);
  expect(notices).toEqual(["Could not read the phone's current app"]);
  expect(logs.some((l) => l.includes("timed out"))).toBe(true);
});

test("an app already open, over the limit or never streaming is not checked again", async () => {
  for (const o of [{ open: "focused" as const }, { open: "limit" as const }, { streams: false }]) {
    const { deps, calls, notices } = harness({ dumps: [dump({ 0: "com.example.chat" }), dump({ 0: "com.example.chat" })], ...o });
    await popOutCurrent(deps);
    expect(calls.filter((c) => c === "dump")).toHaveLength(1);
    expect(notices).toEqual([]);
  }
});

test("a pop-out closed during the wait, a phone gone or a failed second dump gives no notice", async () => {
  for (const o of [{ label: null }, { dumps: [dump({ 0: "com.example.chat" }), new Error("closed")] }]) {
    const { deps, notices } = harness({ dumps: [dump({ 0: "com.example.chat" }), dump({ 0: "com.example.chat" })], ...o });
    await popOutCurrent(deps);
    expect(notices).toEqual([]);
  }
  const gone = harness({ dumps: [dump({ 0: "com.example.chat" }), dump({ 0: "com.example.chat" })] });
  let asked = 0;
  gone.deps.phone = () => (asked++ === 0 ? PHONE : null);
  await popOutCurrent(gone.deps);
  expect(gone.notices).toEqual([]);
  expect(gone.calls.filter((c) => c === "dump")).toHaveLength(1);
});

function shellPhone(stdout: string, commands: string[]): ConnectedPhone {
  const adb = {
    subprocess: {
      shellProtocol: {
        spawn: (command: string) => {
          commands.push(command);
          return { wait: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() }) };
        },
      },
    },
  };
  return { ...PHONE, adb: adb as never };
}

test("the phone is only ever asked for the activities dump, which says whether an app landed on the phone screen", async () => {
  const commands: string[] = [];
  const phone = shellPhone(dump({ 0: "com.example.chat", 2: "com.example.maps" }), commands);

  expect(await dumpActivities(phone)).toContain("com.example.chat");
  expect(await landedOnPhoneScreen(phone, "com.example.chat")).toBe(true);
  expect(await landedOnPhoneScreen(phone, "com.example.maps")).toBe(false);
  const both = shellPhone(dump({ 0: "com.example.chat", 2: "com.example.chat" }), commands);
  expect(await landedOnPhoneScreen(both, "com.example.chat"), "resumed on its own display too, so it did move").toBe(false);
  expect(new Set(commands)).toEqual(new Set(["dumpsys activity activities"]));
});
