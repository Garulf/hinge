import { join } from "node:path";
import { BrowserWindow, MessageChannelMain, ipcMain, screen } from "electron";
import type { MessagePortMain } from "electron";
import type { PortLike } from "./app-controller";
import { clampToWorkArea } from "../shared/clamp-bounds";
import type { MainToRenderer, RendererToMain } from "../shared/wire";
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

  const stopDrag = () => {
    if (dragTimer !== null) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
  };

  ipcMain.on("hinge:set-content-size", (event, width: number, height: number) => {
    if (event.sender !== win.webContents) return;
    const bounds = win.getBounds();
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    win.setContentSize(width, height);
    const next = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const clamped = clampToWorkArea(
      { x: Math.round(centerX - next.width / 2), y: Math.round(centerY - next.height / 2), width: next.width, height: next.height },
      area,
    );
    win.setBounds(clamped);
  });

  ipcMain.on("hinge:set-window-size", (event, width: number, height: number, rotation: 0 | 1 | 2 | 3) => {
    if (event.sender !== win.webContents) return;
    const current = win.getContentBounds();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setContentBounds(anchoredWindowBounds(current, { w: width, h: height }, rotation, area));
  });

  ipcMain.handle("hinge:work-area-height", (event) => {
    if (event.sender !== win.webContents) return 0;
    return screen.getDisplayMatching(win.getBounds()).workArea.height;
  });

  ipcMain.on("hinge:begin-drag", (event) => {
    if (event.sender !== win.webContents) return;
    stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const offset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    dragTimer = setInterval(() => {
      const point = screen.getCursorScreenPoint();
      win.setPosition(point.x - offset.x, point.y - offset.y);
    }, 1000 / 60);
  });

  ipcMain.on("hinge:end-drag", (event) => {
    if (event.sender !== win.webContents) return;
    stopDrag();
  });

  win.on("blur", stopDrag);
}
