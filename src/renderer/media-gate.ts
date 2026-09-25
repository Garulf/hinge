/**
 * Holds stream messages (video and posture) while the scene is still
 * loading, so the device can start in parallel with the model, and replays
 * them in order once the scene is ready or the cap runs out, whichever
 * comes first.
 */
export class MediaGate<T> {
  readonly #deliver: (msg: T) => void;
  #queue: T[] | null = [];

  constructor(deliver: (msg: T) => void, ready: Promise<unknown>, capMs: number) {
    this.#deliver = deliver;
    const timer = setTimeout(() => this.#open(), capMs);
    const open = () => {
      clearTimeout(timer);
      this.#open();
    };
    ready.then(open, open);
  }

  push(msg: T): void {
    if (this.#queue) this.#queue.push(msg);
    else this.#deliver(msg);
  }

  #open(): void {
    const queued = this.#queue;
    if (!queued) return;
    this.#queue = null;
    for (const msg of queued) this.#deliver(msg);
  }
}
