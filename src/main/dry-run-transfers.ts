import type { MediaSink, MediaSource } from "./media-source";
import { createTransferQueue, defaultOpenFile, type TransferDeps } from "./transfers";

async function drain(stream: ReadableStream<Uint8Array>, chunkDelayMs: number): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
    if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
  }
}

/** Reads each dropped file through the real transfer queue but sends it nowhere, so a replay can show transfer toasts without a phone. */
export function dryRunTransferDeps(opts?: { chunkDelayMs?: number; openFile?: TransferDeps["openFile"] }): TransferDeps {
  const chunkDelayMs = opts?.chunkDelayMs ?? 20;
  return {
    openFile: opts?.openFile ?? defaultOpenFile,
    installApk: (stream) => drain(stream, chunkDelayMs),
    pushFile: (_path, stream) => drain(stream, chunkDelayMs),
    scanFile: async () => {},
    removeFile: async () => {},
  };
}

export function withDryRunTransfers(source: MediaSource, deps: TransferDeps = dryRunTransferDeps()): MediaSource {
  const queue = createTransferQueue(deps);
  return {
    start: (sink: MediaSink) => {
      queue.onProgress((progress) => sink.transferProgress?.(progress));
      return source.start(sink);
    },
    control: (intent) => source.control(intent),
    transfer: (paths) => queue.enqueue(paths),
    stop: async () => {
      queue.cancelAll();
      await source.stop();
    },
  };
}
