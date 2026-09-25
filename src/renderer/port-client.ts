import type { MainToRenderer, RendererToMain } from "../shared/wire";

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
