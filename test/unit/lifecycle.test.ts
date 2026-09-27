import { expect, test, vi } from "vitest";
import { afterPopoutClosed, onMainWindowClose, Shutdown, shutdownWithin } from "../../src/main/lifecycle";

test("closing the main window hides it while pop-outs are open, and quits otherwise", () => {
  expect(onMainWindowClose({ popouts: 0 })).toBe("quit");
  expect(onMainWindowClose({ popouts: 1 })).toBe("hide");
});

test("the last pop-out closing quits only when the main window is hidden", () => {
  expect(afterPopoutClosed({ mainVisible: false, popouts: 0 })).toBe("quit");
  expect(afterPopoutClosed({ mainVisible: false, popouts: 1 })).toBe("stay");
  expect(afterPopoutClosed({ mainVisible: true, popouts: 0 })).toBe("stay");
  expect(afterPopoutClosed({ mainVisible: true, popouts: 1 })).toBe("stay");
});

test("shutdown gives up waiting after its limit when a step never finishes", async () => {
  vi.useFakeTimers();
  try {
    let done = false;
    const stopped = shutdownWithin(5000, [() => new Promise<void>(() => {}), async () => {}]).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(done).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("shutdown runs every step even when one fails, and finishes as soon as they are done", async () => {
  const ran: string[] = [];
  await shutdownWithin(5000, [
    async () => {
      ran.push("a");
      throw new Error("boom");
    },
    async () => {
      ran.push("b");
    },
  ]);
  expect(ran).toEqual(["a", "b"]);
});

test("a shutdown asked for again from inside its own first step runs once, and counts as started from its first line", () => {
  const seen: boolean[] = [];
  let runs = 0;
  const shutdown: Shutdown = new Shutdown(() => {
    runs++;
    seen.push(shutdown.started);
    shutdown.request();
  });
  expect(shutdown.started).toBe(false);

  shutdown.request();
  shutdown.request();
  expect(runs).toBe(1);
  expect(seen).toEqual([true]);
});
