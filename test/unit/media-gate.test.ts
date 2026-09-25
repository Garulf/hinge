import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MediaGate } from "../../src/renderer/media-gate";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeScene() {
  let resolve!: () => void;
  const ready = new Promise<void>((r) => {
    resolve = r;
  });
  return { ready, becomeReady: resolve };
}

test("holds messages until the scene is ready, then replays them in order", async () => {
  const scene = fakeScene();
  const delivered: string[] = [];
  const gate = new MediaGate<string>((m) => delivered.push(m), scene.ready, 5000);

  gate.push("video-start");
  gate.push("posture");
  gate.push("video-packet");
  expect(delivered).toEqual([]);

  scene.becomeReady();
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(["video-start", "posture", "video-packet"]);

  gate.push("video-end");
  expect(delivered).toEqual(["video-start", "posture", "video-packet", "video-end"]);
});

test("opens after the cap when the scene never becomes ready", async () => {
  const scene = fakeScene();
  const delivered: string[] = [];
  const gate = new MediaGate<string>((m) => delivered.push(m), scene.ready, 5000);

  gate.push("video-start");
  await vi.advanceTimersByTimeAsync(4999);
  expect(delivered).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(delivered).toEqual(["video-start"]);

  scene.becomeReady();
  await vi.advanceTimersByTimeAsync(0);
  gate.push("video-packet");
  expect(delivered).toEqual(["video-start", "video-packet"]);
});

test("a scene that fails to get ready still opens the gate", async () => {
  const delivered: string[] = [];
  const gate = new MediaGate<string>((m) => delivered.push(m), Promise.reject(new Error("no model")), 5000);
  gate.push("video-start");
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(["video-start"]);
});
