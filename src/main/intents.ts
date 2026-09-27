import type { Adb } from "@yume-chan/adb";
import { runShellText } from "./adb-shell";
import type { ControlIntent, TouchAction } from "../shared/wire";
import { isPackageName } from "../shared/package-name";

export interface ControllerLike {
  injectTouch(m: {
    action: number;
    pointerId: bigint;
    pointerX: number;
    pointerY: number;
    videoWidth: number;
    videoHeight: number;
    pressure: number;
    buttons: number;
    actionButton?: number;
  }): Promise<void>;
  injectScroll(m: {
    pointerX: number;
    pointerY: number;
    videoWidth: number;
    videoHeight: number;
    scrollX: number;
    scrollY: number;
    buttons: number;
  }): Promise<void>;
  injectKeyCode(m: { action: number; keyCode: number; repeat: number; metaState: number }): Promise<void>;
  injectText(text: string): Promise<void>;
  backOrScreenOn(action: number): Promise<void>;
  resetVideo(): Promise<void>;
  setClipboard(m: { content: string; sequence: bigint; paste: boolean }): Promise<void>;
  setDisplayPower(on: boolean): Promise<void>;
  expandNotificationPanel(): Promise<void>;
  expandSettingPanel(): Promise<void>;
  collapseNotificationPanel(): Promise<void>;
  rotateDevice(): Promise<void>;
}

/**
 * Only needed for "clipboard-paste": reading the PC clipboard and issuing a
 * fresh echo-suppression sequence are both main-only concerns the renderer
 * cannot resolve itself, so the unresolved intent carries no content and
 * these deps fill it in here instead.
 */
export interface ApplyIntentDeps {
  readPcClipboard?: () => Promise<string>;
  beginClipboardPush?: (content: string) => bigint;
}

const TOUCH_ACTION: Record<TouchAction, number> = {
  down: 0,
  up: 1,
  move: 2,
  cancel: 3,
};

const KEY_ACTION: Record<"down" | "up", number> = {
  down: 0,
  up: 1,
};

export function applyIntent(c: ControllerLike, intent: ControlIntent, deps?: ApplyIntentDeps): Promise<void> {
  switch (intent.type) {
    case "touch":
      return c.injectTouch({
        action: TOUCH_ACTION[intent.action],
        pointerId: BigInt(intent.pointerId),
        pointerX: intent.x,
        pointerY: intent.y,
        videoWidth: intent.videoWidth,
        videoHeight: intent.videoHeight,
        pressure: intent.pressure,
        buttons: intent.buttons,
      });
    case "scroll":
      return c.injectScroll({
        pointerX: intent.x,
        pointerY: intent.y,
        videoWidth: intent.videoWidth,
        videoHeight: intent.videoHeight,
        scrollX: intent.scrollX,
        scrollY: intent.scrollY,
        buttons: intent.buttons,
      });
    case "key":
      return c.injectKeyCode({
        action: KEY_ACTION[intent.action],
        keyCode: intent.keyCode,
        repeat: intent.repeat,
        metaState: intent.metaState,
      });
    case "text":
      return c.injectText(intent.text);
    case "back-or-screen-on":
      return c.backOrScreenOn(KEY_ACTION[intent.action]);
    case "reset-video":
      return c.resetVideo();
    case "display-power":
      return c.setDisplayPower(intent.on);
    case "expand-notifications":
      return c.expandNotificationPanel();
    case "expand-settings":
      return c.expandSettingPanel();
    case "collapse-panels":
      return c.collapseNotificationPanel();
    case "rotate-device":
      return c.rotateDevice();
    case "clipboard-paste": {
      const readPcClipboard = deps?.readPcClipboard;
      if (!readPcClipboard) return Promise.resolve();
      return (async () => {
        const content = await readPcClipboard();
        if (intent.asText) {
          await c.injectText(content);
          return;
        }
        const sequence = deps?.beginClipboardPush ? deps.beginClipboardPush(content) : 0n;
        await c.setClipboard({ content, sequence, paste: true });
      })();
    }
  }
}

export interface LaunchAppDeps {
  runShell?: (adb: Adb, command: string) => Promise<string>;
}

/** The component name resolve-activity --brief prints is its last non-empty line; earlier lines (if any) are match diagnostics. */
function lastNonEmptyLine(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

const COMPONENT_NAME = /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/;

/** Resolves pkg's launcher activity on the phone and starts it there. A failure to resolve or start is logged, never thrown at the caller. */
export async function launchAppOnPhone(adb: Adb, pkg: string, log: (line: string) => void, deps: LaunchAppDeps = {}): Promise<void> {
  const runShell = deps.runShell ?? runShellText;
  if (!isPackageName(pkg)) {
    log(`not launching ${JSON.stringify(pkg)} on the phone: not an app package`);
    return;
  }
  try {
    const resolved = await runShell(adb, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`);
    const component = lastNonEmptyLine(resolved);
    if (!component || !COMPONENT_NAME.test(component)) throw new Error(`could not resolve a launcher activity for ${pkg}`);
    await runShell(adb, `am start -n ${component}`);
  } catch (e) {
    log(`could not launch ${pkg} on the phone: ${String(e)}`);
  }
}
