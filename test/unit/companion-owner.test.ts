import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectedPhone } from "../../src/main/app-controller";
import type { AudioSink } from "../../src/main/audio-forward";
import { CompanionOwner, type CompanionLike } from "../../src/main/companion-owner";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

class FakeCompanion implements CompanionLike {
  startCalls = 0;
  stopCalls = 0;
  pushes: string[] = [];
  #end!: () => void;
  readonly ended = new Promise<void>((resolve) => {
    this.#end = resolve;
  });

  constructor(readonly phone: ConnectedPhone) {}

  async start(_sink: AudioSink): Promise<void> {
    this.startCalls++;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
  }

  beginPush(content: string): bigint {
    this.pushes.push(content);
    return 7n;
  }

  end(): void {
    this.#end();
  }
}

function fold(tag = "a"): ConnectedPhone {
  return { adb: { tag } as never, serial: "R5CY-serial", deviceId: "R5CY", model: "SM-F966B" };
}

function harness() {
  const made: FakeCompanion[] = [];
  const owner = new CompanionOwner({
    create: (phone) => {
      const c = new FakeCompanion(phone);
      made.push(c);
      return c;
    },
    sink: {},
  });
  return { owner, made };
}

test("runs one companion while a phone is connected and something is showing it", () => {
  const { owner, made } = harness();
  const phone = fold();

  owner.phone(phone);
  expect(made).toHaveLength(0);

  owner.wanted(true);
  expect(made).toHaveLength(1);
  expect(made[0].startCalls).toBe(1);

  owner.wanted(true);
  owner.phone(phone);
  expect(made).toHaveLength(1);
});

test("stops the companion when the phone goes away or nothing shows it any more", () => {
  const { owner, made } = harness();
  owner.wanted(true);
  owner.phone(fold());

  owner.phone(null);
  expect(made[0].stopCalls).toBe(1);

  owner.phone(fold());
  owner.wanted(false);
  expect(made).toHaveLength(2);
  expect(made[1].stopCalls).toBe(1);
});

test("a new transport for the same phone gets a new companion", () => {
  const { owner, made } = harness();
  owner.wanted(true);
  owner.phone(fold("a"));

  owner.phone(fold("b"));

  expect(made).toHaveLength(2);
  expect(made[0].stopCalls).toBe(1);
  expect(made[1].phone.adb).toEqual({ tag: "b" });
});

test("an ended companion is restarted after 1, 2, 4 and then every 8 seconds", async () => {
  const { owner, made } = harness();
  owner.wanted(true);
  owner.phone(fold());

  for (const [i, delay] of [1000, 2000, 4000, 8000, 8000].entries()) {
    made[i].end();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(made, `restart ${i + 1}`).toHaveLength(i + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(made, `restart ${i + 1}`).toHaveLength(i + 2);
  }
});

test("no restart once the phone is gone", async () => {
  const { owner, made } = harness();
  owner.wanted(true);
  owner.phone(fold());

  made[0].end();
  await vi.advanceTimersByTimeAsync(0);
  owner.phone(null);
  await vi.advanceTimersByTimeAsync(10_000);

  expect(made).toHaveLength(1);
});

test("clipboard pushes go through the running companion, and are 0 without one", () => {
  const { owner, made } = harness();
  expect(owner.beginPush("x")).toBe(0n);

  owner.wanted(true);
  owner.phone(fold());

  expect(owner.beginPush("hello")).toBe(7n);
  expect(made[0].pushes).toEqual(["hello"]);
});

test("stop stops the companion and keeps it stopped", async () => {
  const { owner, made } = harness();
  owner.wanted(true);
  owner.phone(fold());

  await owner.stop();
  owner.phone(fold("b"));

  expect(made).toHaveLength(1);
  expect(made[0].stopCalls).toBe(1);
});
