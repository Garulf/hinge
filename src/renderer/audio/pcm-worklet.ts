import { PcmRing } from "../../shared/pcm-ring";

type HostMessage = { type: "feed"; planes: Float32Array[] } | { type: "reset" };

const CHANNELS = 2;

/**
 * Runs inside the AudioWorkletGlobalScope: no access to window, no imports
 * beyond what Vite inlines into this module's own bundle. All buffering
 * policy lives in PcmRing (src/shared/pcm-ring.ts, unit tested on its own);
 * this class is just the Web Audio plumbing around it.
 */
class HingePcmProcessor extends AudioWorkletProcessor {
  readonly #ring: PcmRing;

  constructor() {
    super();
    this.#ring = new PcmRing(sampleRate, CHANNELS);
    this.port.onmessage = (event: MessageEvent<HostMessage>) => {
      if (event.data.type === "feed") this.#ring.push(event.data.planes);
      else this.#ring.reset();
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frameCount = output[0]!.length;
    const planes = this.#ring.pull(frameCount);
    for (let channel = 0; channel < output.length; channel++) {
      const plane = planes[Math.min(channel, planes.length - 1)];
      if (plane) output[channel]!.set(plane);
    }
    return true;
  }
}

registerProcessor("hinge-pcm", HingePcmProcessor);
