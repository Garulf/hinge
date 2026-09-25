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
 */
export class FrameLifecycle {
  #current: VideoFrame | null = null;
  #renderedSinceSet = false;

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
}
