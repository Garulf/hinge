import { expect, test } from "vitest";
import { UnlockController } from "../../src/renderer/unlock/unlock-controller";
import type { Credential } from "../../src/shared/lock";

function setup(enabled = true) {
  const pad = { opened: [] as Credential[], open: false };
  const sent: boolean[] = [];
  let on = enabled;
  const c = new UnlockController({
    pad: { open: (cr) => { pad.opened.push(cr); pad.open = true; }, close: () => { pad.open = false; }, isOpen: () => pad.open },
    sendBlack: (b) => sent.push(b),
    enabled: () => on,
  });
  return { c, pad, sent, setEnabled: (v: boolean) => (on = v) };
}

const LOCKED_PIN = { locked: true, credential: "pin" as const };

test("locked and black opens the pad on its own, once", () => {
  const { c, pad } = setup();
  c.lockState(LOCKED_PIN);
  expect(pad.opened).toEqual([]);
  c.screenBlack(true);
  c.lockState(LOCKED_PIN);
  expect(pad.opened).toEqual(["pin"]);
});

test("every change of blackness, and only a change, goes to main", () => {
  const { c, sent } = setup();
  c.screenBlack(false);
  c.screenBlack(false);
  c.screenBlack(true);
  expect(sent).toEqual([false, true]);
});

test("unlocking closes the pad", () => {
  const { c, pad } = setup();
  c.screenBlack(true);
  c.lockState(LOCKED_PIN);
  c.lockState({ locked: false, credential: "pin" });
  expect(pad.open).toBe(false);
});

test("a cancelled pad stays closed for this lock, and comes back once the screen showed something", () => {
  const { c, pad } = setup();
  c.screenBlack(true);
  c.lockState(LOCKED_PIN);
  pad.open = false;
  c.cancelled();
  c.lockState(LOCKED_PIN);
  c.screenBlack(true);
  expect(pad.opened).toHaveLength(1);
  c.screenBlack(false);
  c.screenBlack(true);
  expect(pad.opened).toHaveLength(2);
});

test("a cancelled pad comes back on the next lock after an unlock", () => {
  const { c, pad } = setup();
  c.screenBlack(true);
  c.lockState(LOCKED_PIN);
  pad.open = false;
  c.cancelled();
  c.lockState({ locked: false, credential: "pin" });
  c.lockState(LOCKED_PIN);
  expect(pad.opened).toHaveLength(2);
});

test("with the setting off, or a pattern lock, it never opens by itself but MOD+l still opens it", () => {
  const { c, pad, setEnabled } = setup(false);
  c.screenBlack(true);
  c.lockState(LOCKED_PIN);
  expect(pad.opened).toEqual([]);
  setEnabled(true);
  c.lockState({ locked: true, credential: "pattern" });
  expect(pad.opened).toEqual([]);
  c.openByHand();
  expect(pad.opened).toEqual(["pattern"]);
});

test("turning the setting on while locked and black opens the pad", () => {
  const { c, pad, setEnabled } = setup(false);
  c.screenBlack(true);
  c.lockState(LOCKED_PIN);
  setEnabled(true);
  c.settingsChanged();
  expect(pad.opened).toEqual(["pin"]);
});

test("opened by hand before main has said anything, the pad asks for a PIN with the lock type unknown", () => {
  const { c, pad } = setup();
  c.openByHand();
  expect(pad.opened).toEqual(["unknown"]);
});
