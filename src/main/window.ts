import { join } from "node:path";
import { BrowserWindow, MessageChannelMain, ipcMain, screen } from "electron";
import type { MessagePortMain } from "electron";
import type { PortLike } from "./app-controller";
import type { MainToRenderer, RendererToMain } from "../shared/wire";

export function createPhoneWindow(): { win: BrowserWindow; port: MessagePortMain } {
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

  const { port1, port2 } = new MessageChannelMain();
  win.webContents.once("did-finish-load", () => {
    win.webContents.postMessage("hinge:port", null, [port2]);
  });

  registerWindowIpc(win);

  return { win, port: port1 };
}

export function portLikeOf(port: MessagePortMain): PortLike {
  return {
    // MessagePortMain.postMessage only transfers other MessagePortMain instances,
    // not ArrayBuffers, so packets cross by value rather than by transfer.
    postMessage: (msg: MainToRenderer) => port.postMessage(msg),
    onMessage: (fn: (msg: RendererToMain) => void) => {
      port.on("message", (e) => fn(e.data as RendererToMain));
      port.start();
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
    win.setBounds({
      x: Math.round(centerX - next.width / 2),
      y: Math.round(centerY - next.height / 2),
      width: next.width,
      height: next.height,
    });
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
