/**
 * Owns a decoded VideoFrame from the moment it becomes the texture's
 * current image until it is safe to close.
 *
 * A frame superseded by a newer one before ever being rendered is safe to
 * close immediately: its bytes were never read by the GPU. The current
 * frame is different, since three.js uploads a texture lazily on the next
 * render; closing it before that render has actually happened leaves the
 * texture pointing at a closed VideoFrame, which the next render tries (and
 * fails) to upload. end() forces one last render so the final frame is not
 * closed before it can be seen.
 *
 * A screen fading out after a handoff keeps showing a clone of the frame
 * that was current when the stream moved away from it; the clone lives
 * under that screen's key until releaseClone(), independent of the stream.
 */
export class FrameLifecycle<Key extends string = string> {
  #current: VideoFrame | null = null;
  #renderedSinceSet = false;
  readonly #clones = new Map<Key, VideoFrame>();

  constructor(private readonly render: () => void) {}

  setFrame(frame: VideoFrame): void {
    this.#current?.close();
    this.#current = frame;
    this.#renderedSinceSet = false;
  }

  /** Call after a render tick that may have uploaded the current frame. */
  onRendered(): void {
    this.#renderedSinceSet = true;
  }

  end(): void {
    if (this.#current && !this.#renderedSinceSet) {
      this.render();
      this.#renderedSinceSet = true;
    }
    this.#current?.close();
    this.#current = null;
  }

  /** Clones the current frame for `key`, replacing any clone it already held; null without a current frame. */
  holdClone(key: Key): VideoFrame | null {
    this.releaseClone(key);
    if (!this.#current) return null;
    const clone = this.#current.clone();
    this.#clones.set(key, clone);
    return clone;
  }

  releaseClone(key: Key): void {
    this.#clones.get(key)?.close();
    this.#clones.delete(key);
  }

  dispose(): void {
    this.#current?.close();
    this.#current = null;
    for (const key of [...this.#clones.keys()]) this.releaseClone(key);
  }
}
