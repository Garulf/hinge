/**
 * TypeScript's bundled DOM lib does not include the AudioWorkletGlobalScope
 * API surface (AudioWorkletProcessor, registerProcessor, sampleRate as a
 * global), so pcm-worklet.ts needs it declared by hand. Scoped to this
 * directory's own worklet code; nothing else in the renderer runs inside an
 * AudioWorkletGlobalScope.
 */
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new (options?: unknown) => AudioWorkletProcessor): void;
