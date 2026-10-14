export type Credential = "pin" | "password" | "pattern" | "none" | "unknown";

export interface LockState {
  locked: boolean;
  credential: Credential;
}

export const UNLOCKED: LockState = { locked: false, credential: "unknown" };

export type UnlockRequest = { kind: "pin" | "password"; secret: string };

/** unconfirmed: sent, but the keyguard state could not be read to tell whether it worked. */
export type UnlockResult = "unlocked" | "still-locked" | "unconfirmed" | "unavailable";

/** Filtered on the phone so only the keyguard block comes back; `|| true` keeps a dump without one from failing as a command. */
export const KEYGUARD_COMMAND = "dumpsys activity activities | grep -A8 KeyguardController || true";
export const CREDENTIAL_COMMAND = "dumpsys lock_settings";

const SHOWING = /\bm?KeyguardShowing=(true|false)/;
const GOING_AWAY = /\bm?KeyguardGoingAway=true/;

/**
 * Whether the keyguard is up, from the KeyguardController block of
 * `dumpsys activity activities`. Older AOSP prints mKeyguardShowing=...,
 * newer AOSP one KeyguardShowing=... line per display, where display 0 is
 * the phone's own screen. A keyguard going away counts as unlocked. null
 * when the dump has neither form.
 */
export function parseKeyguard(dump: string): boolean | null {
  const lines = dump.split("\n").filter((line) => SHOWING.test(line));
  if (lines.length === 0) return null;
  const line = lines.find((l) => /\bdisplay=0\b/.test(l)) ?? lines[0];
  const showing = SHOWING.exec(line)?.[1] === "true";
  const goingAway = GOING_AWAY.test(line) || /\bmKeyguardGoingAway=true/.test(dump);
  return showing && !goingAway;
}

const CREDENTIALS: Record<string, Credential> = { pin: "pin", password: "password", pattern: "pattern", none: "none" };

/**
 * The owner's (user 0) lock type from `dumpsys lock_settings`. AOSP prints
 * `CredentialType: Pin` (or Password, Pattern, None) in each user's block;
 * other users (Samsung's Secure Folder is user 150) have their own.
 */
export function parseCredential(dump: string): Credential {
  let owner = false;
  for (const line of dump.split("\n")) {
    const user = /^\s*User (\d+)\b/.exec(line);
    if (user) {
      owner = user[1] === "0";
      continue;
    }
    const type = owner ? /^\s*CredentialType:\s*(\S+)/i.exec(line) : null;
    if (type) return CREDENTIALS[type[1].toLowerCase()] ?? "unknown";
  }
  return "unknown";
}

export interface AutoShowInput {
  enabled: boolean;
  locked: boolean;
  black: boolean;
  credential: Credential;
  dismissed: boolean;
}

export function shouldAutoShow(i: AutoShowInput): boolean {
  const typeable = i.credential === "pin" || i.credential === "password" || i.credential === "unknown";
  return i.enabled && i.locked && i.black && !i.dismissed && typeable;
}
