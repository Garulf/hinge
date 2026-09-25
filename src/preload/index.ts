import { contextBridge } from "electron";
contextBridge.exposeInMainWorld("hinge", { version: "0.1.0" });
