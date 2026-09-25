import workletUrl from "./pcm-worklet.ts?worker&url";
import type { PcmPlayerFactory, PcmPlayerLike } from "../audio-pipe";

/**
 * The real PcmPlayerLike: an AudioContext driving our own "hinge-pcm"
 * AudioWorkletProcessor (pcm-worklet.ts), which owns a PcmRing for the
 * buffer policy. No third-party audio package involved.
 */
export const createWorkletPlayer: PcmPlayerFactory = (sampleRate, channelCount) => {
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;

  const player: PcmPlayerLike = {
    async start() {
      const context = new AudioContext({ sampleRate });
      await context.audioWorklet.addModule(workletUrl);
      const workletNode = new AudioWorkletNode(context, "hinge-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channelCount],
      });
      workletNode.connect(context.destination);
      ctx = context;
      node = workletNode;
    },
    feed(planes) {
      if (!node) return;
      node.port.postMessage({ type: "feed", planes }, planes.map((p) => p.buffer));
    },
    stop() {
      node?.port.postMessage({ type: "reset" });
      node?.disconnect();
      node = null;
      const context = ctx;
      ctx = null;
      if (context) void context.close().catch(() => {});
    },
  };
  return player;
};
