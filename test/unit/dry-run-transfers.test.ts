import { expect, test } from "vitest";
import { dryRunTransferDeps, withDryRunTransfers } from "../../src/main/dry-run-transfers";
import type { MediaSink, MediaSource } from "../../src/main/media-source";
import type { TransferProgress } from "../../src/shared/wire";

function bytes(n: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(n));
      controller.close();
    },
  });
}

test("a dry-run drop runs through the transfer queue and reports progress to the sink", async () => {
  const inner: MediaSource = { start: async () => {}, control: () => {}, stop: async () => {} };
  const source = withDryRunTransfers(inner, dryRunTransferDeps({ chunkDelayMs: 0, openFile: async () => ({ size: 10, stream: bytes(10) }) }));
  const progress: TransferProgress[] = [];
  const sink = { transferProgress: (p: TransferProgress) => progress.push(p) } as unknown as MediaSink;
  await source.start(sink);
  source.transfer!(["/tmp/My File.apk", "/tmp/photo.jpg"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const finals = progress.filter((p) => p.state === "done").map((p) => [p.name, p.kind]);
  expect(finals).toEqual([
    ["My File.apk", "install"],
    ["photo.jpg", "push"],
  ]);
});
