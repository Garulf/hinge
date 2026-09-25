import type { ControlIntent, TouchAction } from "../shared/wire";

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

export function applyIntent(c: ControllerLike, intent: ControlIntent): Promise<void> {
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
  }
}
