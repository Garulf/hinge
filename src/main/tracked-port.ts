import { MessageChannelMain, type BrowserWindow, type MessagePortMain } from "electron";
import type { MainToRenderer, RendererToMain } from "../shared/wire";
import type { PortLike } from "./app-controller";

/**
 * A MessagePortMain can only be transferred once, and a reloaded page (a
 * crash, Ctrl+R, or a future update) gets a brand new JS context that has
 * lost its old one, so a fresh channel has to be handed over on every
 * did-finish-load, not just the first. bindSource() must keep working
 * against a single stable PortLike across that swap.
 */
export function trackedPort(win: BrowserWindow): PortLike {
  let current: MessagePortMain | null = null;
  const handlers: Array<(msg: RendererToMain) => void> = [];

  function attach(): void {
    const { port1, port2 } = new MessageChannelMain();
    current = port1;
    port1.on("message", (e) => {
      for (const fn of handlers) fn(e.data as RendererToMain);
    });
    port1.start();
    win.webContents.postMessage("hinge:port", null, [port2]);
  }

  win.webContents.on("did-finish-load", attach);

  return {
    postMessage: (msg: MainToRenderer) => current?.postMessage(msg),
    onMessage: (fn: (msg: RendererToMain) => void) => {
      handlers.push(fn);
    },
  };
}
