import type { MainToRenderer, RendererToMain } from "../shared/wire";

/**
 * Requests the transport port from the preload bridge over window.postMessage
 * rather than a bridged function call, since contextBridge copies a
 * MessagePort argument instead of transferring it, leaving it unusable.
 */
export function receivePort(): Promise<MessagePort> {
  return new Promise((resolve) => {
    function onMessage(e: MessageEvent<unknown>): void {
      if (e.source !== window) return;
      const port = e.ports[0];
      if (e.data === "hinge:port" && port) {
        window.removeEventListener("message", onMessage);
        resolve(port);
      }
    }
    window.addEventListener("message", onMessage);
    window.postMessage("hinge:request-port", "*");
  });
}

export class PortClient {
  readonly #port: MessagePort;
  readonly #listeners: ((msg: MainToRenderer) => void)[] = [];

  constructor(port: MessagePort) {
    this.#port = port;
    this.#port.onmessage = (e: MessageEvent<MainToRenderer>) => {
      for (const fn of this.#listeners) fn(e.data);
    };
    this.#port.start();
  }

  on(fn: (msg: MainToRenderer) => void): void {
    this.#listeners.push(fn);
  }

  send(msg: RendererToMain): void {
    this.#port.postMessage(msg);
  }
}
