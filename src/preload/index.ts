import { contextBridge, ipcRenderer } from "electron";
import type { HingeApi } from "./api";

const portListeners: ((port: MessagePort) => void)[] = [];
// The port can arrive before the renderer's module script has run far enough
// to call onPort (did-finish-load races the page's own script execution).
// Buffer it so a late registration still gets delivered.
let bufferedPort: MessagePort | null = null;

ipcRenderer.on("hinge:port", (event) => {
  const port = event.ports[0];
  if (!port) return;
  if (portListeners.length > 0) {
    for (const fn of portListeners) fn(port);
  } else {
    bufferedPort = port;
  }
});

const api: HingeApi = {
  onPort: (fn) => {
    portListeners.push(fn);
    if (bufferedPort) {
      const port = bufferedPort;
      bufferedPort = null;
      fn(port);
    }
  },
  setContentSize: (w, h) => ipcRenderer.send("hinge:set-content-size", w, h),
  beginDrag: () => ipcRenderer.send("hinge:begin-drag"),
  endDrag: () => ipcRenderer.send("hinge:end-drag"),
  workAreaHeight: () => ipcRenderer.invoke("hinge:work-area-height"),
};

contextBridge.exposeInMainWorld("hinge", api);
