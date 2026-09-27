import { BrowserWindow, nativeImage, screen, type WebContents } from "electron";
import { appIconPath } from "./app-icon";
import type { PopoutWindow, Rect } from "./popout-manager";
import { trackedPort } from "./tracked-port";
import { guardNavigation } from "./navigation-guard";
import { focusWindow, loadPage, pageWebPreferences } from "./window";

export interface PopoutWindowOptions {
  pkg: string;
  title: string;
  bounds: Rect | null;
  content: { width: number; height: number };
}

/** webContents lets main tell the pop-out's renderer apart from the main window's. */
export function createPopoutWindow(o: PopoutWindowOptions): PopoutWindow & { readonly webContents: WebContents } {
  const win = new BrowserWindow({
    frame: true,
    resizable: true,
    useContentSize: true,
    width: o.content.width,
    height: o.content.height,
    ...(o.bounds ? { x: o.bounds.x, y: o.bounds.y } : {}),
    minWidth: 160,
    minHeight: 160,
    title: o.title,
    icon: appIconPath(),
    backgroundColor: "#000000",
    show: false,
    webPreferences: pageWebPreferences(),
  });
  // The page's own <title> would otherwise replace the app's name on every load.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());
  guardNavigation(win.webContents);
  loadPage(win, "popout.html");

  let lastBounds: Rect = win.getContentBounds();
  const remember = () => {
    if (!win.isDestroyed()) lastBounds = win.getContentBounds();
  };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("close", remember);

  const port = trackedPort(win);

  return {
    port,
    webContents: win.webContents,
    focus: () => focusWindow(win),
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
    setTitle: (title) => {
      if (!win.isDestroyed()) win.setTitle(title);
    },
    setIcon: (png) => {
      if (!win.isDestroyed()) win.setIcon(nativeImage.createFromBuffer(Buffer.from(png)));
    },
    contentBounds: () => {
      remember();
      return lastBounds;
    },
    scaleFactor: () => (win.isDestroyed() ? 1 : screen.getDisplayMatching(win.getBounds()).scaleFactor),
    onClosed: (cb) => win.on("closed", cb),
  };
}
