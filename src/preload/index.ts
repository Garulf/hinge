import { contextBridge, ipcRenderer } from "electron";
import type { HingeApi } from "./api";

const portListeners: ((port: MessagePort) => void)[] = [];

ipcRenderer.on("hinge:port", (event) => {
  const port = event.ports[0];
  if (port) for (const fn of portListeners) fn(port);
});

const api: HingeApi = {
  onPort: (fn) => { portListeners.push(fn); },
  setContentSize: (w, h) => ipcRenderer.send("hinge:set-content-size", w, h),
  beginDrag: () => ipcRenderer.send("hinge:begin-drag"),
  endDrag: () => ipcRenderer.send("hinge:end-drag"),
  workAreaHeight: () => ipcRenderer.invoke("hinge:work-area-height"),
};

contextBridge.exposeInMainWorld("hinge", api);
