import { app, BrowserWindow } from "electron";
import { join } from "node:path";

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360, height: 760, frame: false, transparent: true, backgroundColor: "#00000000",
    hasShadow: false, resizable: false, show: false,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), sandbox: false },
  });
  win.once("ready-to-show", () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return win;
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
