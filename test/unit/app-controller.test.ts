import { expect, test } from "vitest";
import { bindSource, type PortLike } from "../../src/main/app-controller";
import type { MediaSource, MediaSink } from "../../src/main/media-source";
import type { ControlIntent, MainToRenderer, RendererToMain } from "../../src/shared/wire";

test("forwards source events to the port with transferables and routes control back", async () => {
  const posted: [MainToRenderer, ArrayBuffer[]][] = [];
  let handler: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m, t) => posted.push([m, t]), onMessage: (fn) => { handler = fn; } };
  const got: ControlIntent[] = [];
  let sink!: MediaSink;
  const source: MediaSource = { start: async (s) => { sink = s; }, control: (i) => got.push(i), stop: async () => {} };
  bindSource(source, port);
  handler({ kind: "ready" });
  await Promise.resolve();
  const data = new Uint8Array([1, 2]);
  sink.videoPacket({ type: "configuration", data });
  expect(posted[0]).toEqual([{ kind: "video-packet", packet: { type: "configuration", data } }, [data.buffer]]);
  handler({ kind: "control", intent: { type: "text", text: "x" } });
  expect(got).toEqual([{ type: "text", text: "x" }]);
});

test("source starts only after the renderer says ready", async () => {
  let started = false;
  let handler: (m: RendererToMain) => void = () => {};
  bindSource({ start: async () => { started = true; }, control: () => {}, stop: async () => {} }, { postMessage: () => {}, onMessage: (fn) => { handler = fn; } });
  expect(started).toBe(false);
  handler({ kind: "ready" });
  expect(started).toBe(true);
});
