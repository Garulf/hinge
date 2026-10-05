import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseCredential, parseKeyguard, shouldAutoShow, type AutoShowInput } from "../../src/shared/lock";

// Modelled on AOSP's KeyguardController and LockSettingsService dumps, not captured from the Fold 7: unverified against One UI.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
const KEYGUARD = fixture("dumpsys-keyguard-aosp.txt");
const PER_DISPLAY = fixture("dumpsys-keyguard-per-display-aosp.txt");
const LOCK_SETTINGS = fixture("dumpsys-lock-settings-aosp.txt");

test("mKeyguardShowing=true is locked, false is unlocked", () => {
  expect(parseKeyguard(KEYGUARD)).toBe(true);
  expect(parseKeyguard(KEYGUARD.replace("mKeyguardShowing=true", "mKeyguardShowing=false"))).toBe(false);
});

test("a keyguard going away counts as unlocked", () => {
  expect(parseKeyguard(KEYGUARD.replace("mKeyguardGoingAway=false", "mKeyguardGoingAway=true"))).toBe(false);
});

test("the per-display form is read for display 0, whatever order the displays come in", () => {
  expect(parseKeyguard(PER_DISPLAY)).toBe(true);
  const display0Unlocked = PER_DISPLAY.replace("KeyguardShowing=true KeyguardGoingAway=false Occluded=false at display=0", "KeyguardShowing=false KeyguardGoingAway=false Occluded=false at display=0");
  expect(parseKeyguard(display0Unlocked)).toBe(false);
  const display0GoingAway = PER_DISPLAY.replace("KeyguardShowing=true KeyguardGoingAway=false Occluded=false at display=0", "KeyguardShowing=true KeyguardGoingAway=true Occluded=false at display=0");
  expect(parseKeyguard(display0GoingAway)).toBe(false);
});

test("a dump with no keyguard line is unknown", () => {
  expect(parseKeyguard("")).toBeNull();
  expect(parseKeyguard("  KeyguardController:\n    mDismissalRequested=false\n")).toBeNull();
});

test("the owner's (user 0) lock type is read, not another user's", () => {
  expect(parseCredential(LOCK_SETTINGS)).toBe("pin");
});

test("lock types are matched without case; anything else is unknown", () => {
  const withType = (type: string) => LOCK_SETTINGS.replace("CredentialType: Pin", `CredentialType: ${type}`);
  expect(parseCredential(withType("PIN"))).toBe("pin");
  expect(parseCredential(withType("Password"))).toBe("password");
  expect(parseCredential(withType("Pattern"))).toBe("pattern");
  expect(parseCredential(withType("None"))).toBe("none");
  expect(parseCredential(withType("PasswordOrPin"))).toBe("unknown");
  expect(parseCredential("Current lock settings service state:\n")).toBe("unknown");
});

const SHOWS: AutoShowInput = { enabled: true, locked: true, black: true, credential: "pin", dismissed: false };

test("the pad shows itself only when every condition holds", () => {
  expect(shouldAutoShow(SHOWS)).toBe(true);
  expect(shouldAutoShow({ ...SHOWS, credential: "password" })).toBe(true);
  expect(shouldAutoShow({ ...SHOWS, credential: "unknown" })).toBe(true);
  expect(shouldAutoShow({ ...SHOWS, enabled: false })).toBe(false);
  expect(shouldAutoShow({ ...SHOWS, locked: false })).toBe(false);
  expect(shouldAutoShow({ ...SHOWS, black: false })).toBe(false);
  expect(shouldAutoShow({ ...SHOWS, dismissed: true })).toBe(false);
});

test("a pattern lock or no lock never shows the pad by itself", () => {
  expect(shouldAutoShow({ ...SHOWS, credential: "pattern" })).toBe(false);
  expect(shouldAutoShow({ ...SHOWS, credential: "none" })).toBe(false);
});
