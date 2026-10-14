import { expect, test } from "vitest";
import { unlockLayout } from "../../src/renderer/unlock/unlock-layout";
import type { UnlockView } from "../../src/renderer/unlock/unlock-model";
import { animating, paintUnlock, shakeOffset, SHAKE_MS } from "../../src/renderer/unlock/unlock-paint";

function recordingCtx() {
  const texts: string[] = [];
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "measureText") return (t: string) => ({ width: t.length * 10 });
      if (prop === "fillText") return (t: string) => texts.push(t);
      return () => calls.push(prop);
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, calls };
}

const PIN: UnlockView = { mode: "pin", busy: false, error: false, prompt: "Enter PIN", hint: null, entered: 2, okEnabled: false, pressed: null, switchLabel: null, shakeSince: null };

test("the PIN pad draws its prompt, every key label and Cancel", () => {
  const { ctx, texts } = recordingCtx();
  paintUnlock(ctx, PIN, unlockLayout(360, 640, "pin", false), { w: 360, h: 640 }, 0);
  expect(texts).toEqual(expect.arrayContaining(["Enter PIN", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "OK", "Cancel"]));
});

test("the password field shows one bullet per character and the switch link", () => {
  const { ctx, texts } = recordingCtx();
  const view: UnlockView = { ...PIN, mode: "password", prompt: "Enter password", hint: "Type on your keyboard, then press Enter", entered: 5, switchLabel: "Use PIN" };
  paintUnlock(ctx, view, unlockLayout(360, 640, "password", true), { w: 360, h: 640 }, 0);
  expect(texts).toEqual(expect.arrayContaining(["Enter password", "•••••", "Use PIN", "Cancel"]));
});

test("the pattern card draws its two lines and Cancel only", () => {
  const { ctx, texts } = recordingCtx();
  const view: UnlockView = { ...PIN, mode: "pattern", prompt: "Pattern unlock isn't supported yet", hint: "Unlock on the phone.", entered: 0 };
  paintUnlock(ctx, view, unlockLayout(360, 640, "pattern", false), { w: 360, h: 640 }, 0);
  expect(texts).toEqual(["Pattern unlock isn't supported yet", "Unlock on the phone.", "Cancel"]);
});

test("a shake moves the entry for SHAKE_MS and then settles; busy and shaking keep animating", () => {
  expect(shakeOffset(null, 100, 1)).toBe(0);
  expect(Math.abs(shakeOffset(0, SHAKE_MS / 12, 1))).toBeGreaterThan(0);
  expect(shakeOffset(0, SHAKE_MS, 1)).toBe(0);
  expect(animating({ ...PIN, busy: true }, 0)).toBe(true);
  expect(animating({ ...PIN, shakeSince: 0 }, SHAKE_MS / 2)).toBe(true);
  expect(animating({ ...PIN, shakeSince: 0 }, SHAKE_MS + 1)).toBe(false);
  expect(animating(PIN, 0)).toBe(false);
});
