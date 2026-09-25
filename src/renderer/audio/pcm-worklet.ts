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
    // Writes straight into the browser's own render buffers: no allocation
    // on this callback, which fires roughly every 128 frames (~2.7ms at
    // 48kHz, ~375 times/sec).
    this.#ring.pullInto(output);
    return true;
  }
}

registerProcessor("hinge-pcm", HingePcmProcessor);
