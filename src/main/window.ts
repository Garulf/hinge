import { join } from "node:path";
import { BrowserWindow, MessageChannelMain, ipcMain, screen } from "electron";
import type { MessagePortMain } from "electron";
import type { PortLike } from "./app-controller";
import type { MainToRenderer, RendererToMain } from "../shared/wire";
import type { Rotation } from "../shared/screen-uv";
import { anchoredWindowBounds } from "./window-resize";

export function createPhoneWindow(): { win: BrowserWindow; port: PortLike } {
  const win = new BrowserWindow({
    width: 360,
    height: 760,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    title: "hinge",
    show: false,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), sandbox: false },
  });
  win.once("ready-to-show", () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));

  const port = trackedPort(win);

  registerWindowIpc(win);

  return { win, port };
}

/**
 * A MessagePortMain can only be transferred once, and a reloaded page (a
 * crash, Ctrl+R, or a future update) gets a brand new JS context that has
 * lost its old one, so a fresh channel has to be handed over on every
 * did-finish-load, not just the first. bindSource() must keep working
 * against a single stable PortLike across that swap.
 */
function trackedPort(win: BrowserWindow): PortLike {
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

function registerWindowIpc(win: BrowserWindow): void {
  let dragTimer: ReturnType<typeof setInterval> | null = null;
  let dragSize: { width: number; height: number } | null = null;
  let placedRotation: Rotation | null = null;

  const stopDrag = () => {
    if (dragTimer !== null) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    dragSize = null;
  };

  ipcMain.on("hinge:set-window-size", (event, width: number, height: number, rotation: Rotation) => {
    if (event.sender !== win.webContents) return;
    const current = win.getContentBounds();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setContentBounds(anchoredWindowBounds(current, { w: width, h: height }, rotation, placedRotation, area));
    placedRotation = rotation;
    if (dragSize) dragSize = sizeOf(win.getBounds());
  });

  ipcMain.handle("hinge:work-area-height", (event) => {
    if (event.sender !== win.webContents) return 0;
    return screen.getDisplayMatching(win.getBounds()).workArea.height;
  });

  // setPosition() at a fractional scale factor recomputes the size from
  // rounded device pixels on every call, which can grow the window a pixel
  // at a time during a drag; setBounds() with a size read once does not.
  ipcMain.on("hinge:begin-drag", (event) => {
    if (event.sender !== win.webContents) return;
    stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const offset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    dragSize = sizeOf(bounds);
    dragTimer = setInterval(() => {
      if (!dragSize) return;
      const point = screen.getCursorScreenPoint();
      win.setBounds({ x: point.x - offset.x, y: point.y - offset.y, ...dragSize });
    }, 1000 / 60);
  });

  ipcMain.on("hinge:end-drag", (event) => {
    if (event.sender !== win.webContents) return;
    stopDrag();
  });

  win.on("blur", stopDrag);
}

function sizeOf(bounds: { width: number; height: number }): { width: number; height: number } {
  return { width: bounds.width, height: bounds.height };
}
