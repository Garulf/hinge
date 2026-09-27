import { currentAppPackage, resumedOnPhoneScreen, stayedOnPhoneScreen } from "../shared/activities";
import { runShellChecked, withinTimeout } from "./adb-shell";
import type { ConnectedPhone } from "./app-controller";
import type { PopoutManager } from "./popout-manager";

/** How long a popped-out app gets to move off the phone screen once its pop-out streams. */
export const STAY_CHECK_MS = 3000;

export interface CurrentAppDeps {
  phone(): ConnectedPhone | null;
  /** `dumpsys activity activities`, bounded in time; it must never send the phone input. */
  dumpActivities(phone: ConnectedPhone): Promise<string>;
  popouts: Pick<PopoutManager, "open" | "whenStreaming" | "label">;
  notice(text: string): void;
  log(line: string): void;
  wait?(ms: number): Promise<void>;
}

/** Reads which activity each display shows; only reads, so it never moves or touches anything on the phone. */
export function dumpActivities(phone: ConnectedPhone): Promise<string> {
  return withinTimeout((signal) => runShellChecked(phone.adb, "dumpsys activity activities", signal), "the activities dump");
}

/** For PopoutManager's refusal check: the app landed on the phone screen instead of its pop-out's display. */
export async function landedOnPhoneScreen(phone: ConnectedPhone, pkg: string): Promise<boolean> {
  return resumedOnPhoneScreen(await dumpActivities(phone), pkg);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pops out the app on the phone's own screen, and says so if Android left it there instead of moving it. */
export async function popOutCurrent(deps: CurrentAppDeps): Promise<void> {
  const phone = deps.phone();
  if (!phone) {
    deps.notice("No phone connected");
    return;
  }
  let pkg: string | null;
  try {
    pkg = currentAppPackage(await deps.dumpActivities(phone));
  } catch (e) {
    deps.log(`reading the phone's current app failed: ${String(e)}`);
    deps.notice("Could not read the phone's current app");
    return;
  }
  if (!pkg) {
    deps.notice("Nothing to pop out");
    return;
  }
  if (deps.popouts.open(pkg) !== "opened") return;
  if (!(await deps.popouts.whenStreaming(pkg))) return;
  await (deps.wait ?? sleep)(STAY_CHECK_MS);
  const still = deps.phone();
  const label = deps.popouts.label(pkg);
  if (!still || label === null) return;
  try {
    if (stayedOnPhoneScreen(await deps.dumpActivities(still), pkg)) deps.notice(`${label} stayed on the phone screen`);
  } catch (e) {
    deps.log(`checking where ${pkg} opened failed: ${String(e)}`);
  }
}
