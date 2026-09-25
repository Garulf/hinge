import { expect, test } from "vitest";
import { TOAST_LIFE_MS, ToastQueue } from "../../src/renderer/chrome/toast-queue";

test("a toast lasts three seconds and toasts stack oldest first", () => {
  const q = new ToastQueue();
  q.show({ text: "one" }, 0);
  q.show({ text: "two", tone: "error" }, 1000);
  expect(q.visible(500).map((t) => t.text)).toEqual(["one", "two"]);
  expect(q.visible(TOAST_LIFE_MS).map((t) => t.text)).toEqual(["two"]);
  expect(q.visible(1000 + TOAST_LIFE_MS)).toEqual([]);
});

test("showing the same id again updates it in place and restarts its three seconds", () => {
  const q = new ToastQueue();
  q.show({ id: "t1", text: "Pushing a.jpg", progress: 0.2, sticky: true }, 0);
  q.show({ text: "other" }, 10);
  q.show({ id: "t1", text: "Pushing a.jpg", progress: 0.8, sticky: true }, 20_000);
  expect(q.visible(20_000).map((t) => [t.id, t.progress])).toEqual([["t1", 0.8]]);
  q.show({ id: "t1", text: "Pushed a.jpg" }, 21_000);
  expect(q.visible(21_000 + TOAST_LIFE_MS - 1).map((t) => t.text)).toEqual(["Pushed a.jpg"]);
  expect(q.visible(21_000 + TOAST_LIFE_MS)).toEqual([]);
});

test("sticky toasts stay until dismissed", () => {
  const q = new ToastQueue();
  const id = q.show({ text: "Installing", sticky: true }, 0);
  expect(q.visible(60_000)).toHaveLength(1);
  expect(q.nextExpiryMs()).toBeNull();
  q.dismiss(id);
  expect(q.visible(60_000)).toEqual([]);
});

test("at most four are shown; the oldest timed toast goes first, sticky ones last", () => {
  const q = new ToastQueue();
  q.show({ id: "s", text: "sticky", sticky: true }, 0);
  for (let i = 1; i <= 4; i++) q.show({ text: `t${i}` }, i);
  expect(q.visible(5).map((t) => t.text)).toEqual(["sticky", "t2", "t3", "t4"]);
  expect(q.nextExpiryMs()).toBe(2 + TOAST_LIFE_MS);
});
