import { contextBridge, ipcRenderer } from "electron";
import type { HingeApi } from "./api";

// contextBridge copies function arguments across the isolated/main world
// boundary rather than transferring them; a MessagePort survives that copy
// as a plain object with no working methods. The only way to hand the main
// world a functioning port is a native window.postMessage transfer, so the
// port never crosses through a bridged function call. The main world asks
// for the port (see receivePort in port-client.ts) once it is ready to
// receive it, since posting before that listener exists would lose it.
let port: MessagePort | null = null;
let requested = false;

function deliverIfReady(): void {
  if (!port || !requested) return;
  const toSend = port;
  port = null;
  requested = false;
  window.postMessage("hinge:port", "*", [toSend]);
}

ipcRenderer.on("hinge:port", (event) => {
  port = event.ports[0] ?? null;
  deliverIfReady();
});

window.addEventListener("message", (event) => {
  if (event.source === window && event.data === "hinge:request-port") {
    requested = true;
    deliverIfReady();
  }
});

const api: HingeApi = {
  setWindowSize: (w, h, rotation) => ipcRenderer.send("hinge:set-window-size", w, h, rotation),
  beginDrag: () => ipcRenderer.send("hinge:begin-drag"),
  endDrag: () => ipcRenderer.send("hinge:end-drag"),
  workAreaHeight: () => ipcRenderer.invoke("hinge:work-area-height"),
};

contextBridge.exposeInMainWorld("hinge", api);
