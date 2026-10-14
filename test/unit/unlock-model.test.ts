import { expect, test } from "vitest";
import { UnlockModel, type KeyLike } from "../../src/renderer/unlock/unlock-model";
import type { UnlockRequest } from "../../src/shared/lock";

function model() {
  const submitted: UnlockRequest[] = [];
  let cancels = 0;
  let now = 1000;
  const m = new UnlockModel({ submit: (r) => submitted.push(r), cancel: () => cancels++, now: () => now });
  return { m, submitted, cancels: () => cancels, setNow: (t: number) => (now = t) };
}

const down = (key: string, over: Partial<KeyLike> = {}): KeyLike => ({ type: "keydown", key, ctrlKey: false, altKey: false, metaKey: false, ...over });

test("clicking keys enters a PIN; OK submits it once it has 4 digits", () => {
  const { m, submitted } = model();
  m.open("pin");
  for (const id of ["1", "2", "3"] as const) m.press(id);
  expect(m.view().okEnabled).toBe(false);
  m.press("ok");
  expect(submitted).toEqual([]);
  m.press("4");
  expect(m.view()).toMatchObject({ entered: 4, okEnabled: true, prompt: "Enter PIN" });
  m.press("ok");
  expect(submitted).toEqual([{ kind: "pin", secret: "1234" }]);
  expect(m.view()).toMatchObject({ busy: true, entered: 4 });
});

test("back deletes the last digit; a PIN stops at 16 digits", () => {
  const { m, submitted } = model();
  m.open("pin");
  for (let i = 0; i < 20; i++) m.press("7");
  expect(m.view().entered).toBe(16);
  m.press("back");
  expect(m.view().entered).toBe(15);
  m.press("ok");
  expect(submitted[0].secret).toBe("7".repeat(15));
});

test("the PC keyboard types digits, Backspace deletes, Enter submits, letters are swallowed on a PIN", () => {
  const { m, submitted } = model();
  m.open("pin");
  for (const k of ["1", "a", "2", "3", "9"]) expect(m.key(down(k))).toBe(true);
  expect(m.key(down("Backspace"))).toBe(true);
  m.key(down("4"));
  expect(m.key(down("Enter"))).toBe(true);
  expect(submitted).toEqual([{ kind: "pin", secret: "1234" }]);
});

test("a password takes any printable key and AltGr text, not Ctrl or Alt combos, and Enter submits", () => {
  const { m, submitted } = model();
  m.open("password");
  for (const k of ["h", "U", "n", "!"]) m.key(down(k));
  m.key(down("@", { ctrlKey: true, altKey: true }));
  expect(m.key(down("c", { ctrlKey: true }))).toBe(false);
  expect(m.key(down("x", { altKey: true }))).toBe(false);
  expect(m.key(down("Tab"))).toBe(false);
  m.key(down("Enter"));
  expect(submitted).toEqual([{ kind: "password", secret: "hUn!@" }]);
});

test("key-ups are never claimed", () => {
  const { m } = model();
  m.open("pin");
  expect(m.key({ ...down("1"), type: "keyup" })).toBe(false);
});

test("Escape and Cancel cancel, even while busy", () => {
  const { m, cancels } = model();
  m.open("pin");
  m.key(down("Escape"));
  expect(cancels()).toBe(1);
  m.open("pin");
  for (const id of ["1", "2", "3", "4", "ok"] as const) m.press(id);
  m.press("cancel");
  expect(cancels()).toBe(2);
});

test("while busy nothing else is taken", () => {
  const { m, submitted } = model();
  m.open("pin");
  for (const id of ["1", "2", "3", "4", "ok"] as const) m.press(id);
  m.press("5");
  m.key(down("6"));
  m.key(down("Enter"));
  expect(submitted).toHaveLength(1);
  expect(m.view().entered).toBe(4);
});

test("still locked: back to an empty entry, an error prompt and a shake; never resubmitted", () => {
  const { m, submitted, setNow } = model();
  m.open("pin");
  for (const id of ["1", "2", "3", "4", "ok"] as const) m.press(id);
  setNow(5000);
  expect(m.result("still-locked")).toBe("stay");
  expect(m.view()).toMatchObject({ busy: false, error: true, prompt: "Incorrect. Try again", entered: 0, shakeSince: 5000 });
  expect(submitted).toHaveLength(1);
});

test("unlocked or unconfirmed closes the pad; unavailable says there is no phone", () => {
  const { m } = model();
  for (const [result, outcome] of [["unlocked", "close"], ["unconfirmed", "close"], ["unavailable", "stay"]] as const) {
    m.open("pin");
    for (const id of ["1", "2", "3", "4", "ok"] as const) m.press(id);
    expect(m.result(result)).toBe(outcome);
  }
  expect(m.view()).toMatchObject({ prompt: "No phone connected", error: true, entered: 0 });
});

test("an unknown lock type opens on the PIN pad with a link to the password field and back", () => {
  const { m } = model();
  m.open("unknown");
  expect(m.view()).toMatchObject({ mode: "pin", switchLabel: "Use password" });
  m.press("1");
  m.press("switch");
  expect(m.view()).toMatchObject({ mode: "password", switchLabel: "Use PIN", entered: 0, prompt: "Enter password" });
  m.open("pin");
  expect(m.view().switchLabel).toBeNull();
});

test("a pattern lock gets the unsupported card, which only cancels", () => {
  const { m, submitted } = model();
  m.open("pattern");
  expect(m.view()).toMatchObject({ mode: "pattern", prompt: "Pattern unlock isn't supported yet", hint: "Unlock on the phone." });
  expect(m.key(down("1"))).toBe(false);
  m.key(down("Enter"));
  expect(submitted).toEqual([]);
});

test("a press counts only when released on the key it went down on", () => {
  const { m } = model();
  m.open("pin");
  m.pressDown("5");
  expect(m.view().pressed).toBe("5");
  m.pressUp("6");
  expect(m.view()).toMatchObject({ pressed: null, entered: 0 });
  m.pressDown("5");
  m.pressUp("5");
  expect(m.view().entered).toBe(1);
});

test("the view never carries the secret itself", () => {
  const { m } = model();
  m.open("password");
  for (const k of "hunter22") m.key(down(k));
  expect(JSON.stringify(m.view())).not.toContain("hunter");
});
