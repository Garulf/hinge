/** hinge keeps running, its main window hidden, while any pop-out is open. */
export function onMainWindowClose(o: { popouts: number }): "hide" | "quit" {
  return o.popouts > 0 ? "hide" : "quit";
}

export function afterPopoutClosed(o: { mainVisible: boolean; popouts: number }): "quit" | "stay" {
  return !o.mainVisible && o.popouts === 0 ? "quit" : "stay";
}

/** Runs every step of a shutdown at once, but never waits more than `limitMs` for them: quitting must not hang on a phone that stopped answering. */
export function shutdownWithin(limitMs: number, steps: Array<() => Promise<unknown>>): Promise<void> {
  const all = Promise.all(steps.map((step) => step().catch(() => {}))).then(() => {});
  return Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, limitMs))]);
}

/** A shutdown that any path may ask for, one of its own steps included: it counts as started before its first step runs, so it runs once. */
export class Shutdown {
  #started = false;

  constructor(private readonly run: () => void) {}

  get started(): boolean {
    return this.#started;
  }

  request(): void {
    if (this.#started) return;
    this.#started = true;
    this.run();
  }
}
