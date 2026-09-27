import { join } from "node:path";
import { BrowserWindow, ipcMain, screen, type WebPreferences } from "electron";
import type { PortLike } from "./app-controller";
import type { Rotation } from "../shared/screen-uv";
import { appIconPath } from "./app-icon";
import { guardNavigation } from "./navigation-guard";
import { trackedPort } from "./tracked-port";
import { NO_PAD, type Pad } from "../shared/layout";
import { WindowPlacer } from "./window-resize";

/** Shared by every hinge page: the preload's port hand-over and its window.hinge API. */
export function pageWebPreferences(): WebPreferences {
  return { preload: join(import.meta.dirname, "../preload/index.cjs"), sandbox: false };
}

/** Loads one of the renderer's pages: the dev server's in development, the built file otherwise. */
export function loadPage(win: BrowserWindow, page: "index.html" | "popout.html"): void {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void win.loadURL(page === "index.html" ? devServer : `${devServer}/${page}`);
  else void win.loadFile(join(import.meta.dirname, "../renderer", page));
}

export function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export interface PhoneWindowOptions {
  /** Fires when a drag ends or the window system reports a finished move. */
  onMoved?: () => void;
  /** false keeps the window hidden until shown by hand. */
  showWhenReady?: boolean;
  /** MOD+q; closes the window when not given. */
  onQuit?: () => void;
}

export function createPhoneWindow(opts?: PhoneWindowOptions): { win: BrowserWindow; port: PortLike } {
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
    icon: appIconPath(),
    show: false,
    webPreferences: pageWebPreferences(),
  });
  if (opts?.showWhenReady ?? true) win.once("ready-to-show", () => win.show());
  guardNavigation(win.webContents);
  loadPage(win, "index.html");

  const port = trackedPort(win);

  registerWindowIpc(win, opts?.onMoved ?? (() => {}), opts?.onQuit ?? (() => win.close()));

  return { win, port };
}

function registerWindowIpc(win: BrowserWindow, onMoved: () => void, onQuit: () => void): void {
  let dragTimer: ReturnType<typeof setInterval> | null = null;
  let dragSize: { width: number; height: number } | null = null;
  const placer = new WindowPlacer();

  const stopDrag = () => {
    if (dragTimer !== null) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    dragSize = null;
  };

  ipcMain.on("hinge:set-window-size", (event, width: number, height: number, rotation: Rotation, pad: Pad = NO_PAD) => {
    if (event.sender !== win.webContents || win.isFullScreen()) return;
    const current = win.getContentBounds();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setContentBounds(placer.place(current, { w: width, h: height }, rotation, area, pad));
    if (dragSize) dragSize = sizeOf(win.getBounds());
  });

  ipcMain.handle("hinge:work-area", (event) => {
    if (event.sender !== win.webContents) return { width: 0, height: 0 };
    const { width, height } = screen.getDisplayMatching(win.getBounds()).workArea;
    return { width, height };
  });

  // setPosition() at a fractional scale factor recomputes the size from
  // rounded device pixels on every call, which can grow the window a pixel
  // at a time during a drag; setBounds() with a size read once does not.
  ipcMain.on("hinge:begin-drag", (event) => {
    if (event.sender !== win.webContents || win.isFullScreen()) return;
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
    const wasDragging = dragTimer !== null;
    stopDrag();
    if (wasDragging) onMoved();
  });
  win.on("moved", onMoved);

  win.on("blur", stopDrag);
  win.on("closed", stopDrag);

  ipcMain.on("hinge:toggle-fullscreen", (event) => {
    if (event.sender !== win.webContents) return;
    stopDrag();
    win.setFullScreen(!win.isFullScreen());
  });
  win.on("enter-full-screen", () => win.webContents.send("hinge:fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("hinge:fullscreen", false));

  ipcMain.on("hinge:quit", (event) => {
    if (event.sender === win.webContents) onQuit();
  });
}

function sizeOf(bounds: { width: number; height: number }): { width: number; height: number } {
  return { width: bounds.width, height: bounds.height };
}
