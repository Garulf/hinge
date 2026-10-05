import { expect, test } from "vitest";
import { UnlockOverlay } from "../../src/renderer/unlock/unlock-overlay";
import type { OverlayCanvas } from "../../src/renderer/status-overlay";
import type { UnlockRequest } from "../../src/shared/lock";

function fakeCanvas(): OverlayCanvas {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : p === "measureText" ? () => ({ width: 10 }) : () => {}),
    set: (t, p: string, v) => ((t[p] = v), true),
  });
  return { width: 1, height: 1, getContext: () => ctx as unknown as CanvasRenderingContext2D };
}

function setup() {
  const submitted: UnlockRequest[] = [];
  let cancelled = 0;
  let changed = 0;
  let opened = 0;
  const overlay = new UnlockOverlay({
    submit: (r) => submitted.push(r),
    cancelled: () => cancelled++,
    changed: () => changed++,
    opened: () => opened++,
    canvas: fakeCanvas(),
    makeTexture: () => ({ needsUpdate: false, dispose() {} }),
    now: () => 0,
  });
  overlay.applySize(360, 640);
  return { overlay, submitted, cancelled: () => cancelled, changed: () => changed, opened: () => opened };
}

function tap(overlay: UnlockOverlay, id: Parameters<UnlockOverlay["hitPoint"]>[0]): void {
  const at = overlay.hitPoint(id)!;
  overlay.pointerDown(at.u, at.v);
  overlay.pointerUp(at);
}

test("hidden until opened; opening shows the mesh and says so", () => {
  const { overlay, opened, changed } = setup();
  expect(overlay.isOpen()).toBe(false);
  expect(overlay.mesh.visible).toBe(false);
  overlay.open("pin");
  expect(overlay.isOpen()).toBe(true);
  expect(opened()).toBe(1);
  expect(changed()).toBeGreaterThan(0);
});

test("tapping keys at their points enters and submits a PIN", () => {
  const { overlay, submitted } = setup();
  overlay.open("pin");
  for (const id of ["2", "5", "8", "0", "ok"] as const) tap(overlay, id);
  expect(submitted).toEqual([{ kind: "pin", secret: "2580" }]);
});

test("a press released off the pad does nothing", () => {
  const { overlay } = setup();
  overlay.open("pin");
  const at = overlay.hitPoint("5")!;
  overlay.pointerDown(at.u, at.v);
  overlay.pointerUp(null);
  expect(overlay.view()).toMatchObject({ entered: 0, pressed: null });
});

test("Cancel hides the pad and reports the cancel", () => {
  const { overlay, cancelled } = setup();
  overlay.open("pin");
  tap(overlay, "cancel");
  expect(overlay.isOpen()).toBe(false);
  expect(cancelled()).toBe(1);
});

test("an unlocked result hides it; a wrong PIN keeps it open with the error", () => {
  const { overlay } = setup();
  overlay.open("pin");
  for (const id of ["1", "1", "1", "1", "ok"] as const) tap(overlay, id);
  overlay.result("still-locked");
  expect(overlay.isOpen()).toBe(true);
  expect(overlay.view().prompt).toBe("Incorrect. Try again");
  for (const id of ["1", "2", "3", "4", "ok"] as const) tap(overlay, id);
  overlay.result("unlocked");
  expect(overlay.isOpen()).toBe(false);
});

test("a result for a pad already closed is ignored", () => {
  const { overlay } = setup();
  overlay.result("still-locked");
  expect(overlay.isOpen()).toBe(false);
});

test("hit points are fractions of the pad, so they hold at any size", () => {
  const { overlay } = setup();
  overlay.open("pin");
  const small = overlay.hitPoint("5")!;
  overlay.applySize(720, 1280);
  expect(overlay.hitPoint("5")).toEqual(small);
});
