import { expect, test } from "vitest";
import type { PortLike } from "../../src/main/app-controller";
import type { MediaSink } from "../../src/main/media-source";
import { bindPopoutPort } from "../../src/main/popout-port";
import type { PopoutSessionLike } from "../../src/main/popout-manager";
import type { DisplayGeometry } from "../../src/shared/popout";
import type { ControlIntent, MainToRenderer, RendererToMain } from "../../src/shared/wire";

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function harness() {
  const posted: MainToRenderer[] = [];
  let send: (m: RendererToMain) => void = () => {};
  const port: PortLike = { postMessage: (m) => posted.push(m), onMessage: (fn) => { send = fn; } };
  const controls: ControlIntent[] = [];
  const resizes: DisplayGeometry[] = [];
  let startCalls = 0;
  let sink!: MediaSink;
  const session: PopoutSessionLike = {
    start: async (s) => {
      startCalls++;
      sink = s;
    },
    control: (i) => controls.push(i),
    stop: async () => {},
    resize: (g) => resizes.push(g),
    onAppStarted: () => {},
  };
  const viewports: [number, number, number][] = [];
  let retries = 0;
  const bound = bindPopoutPort(session, port, {
    viewport: (w, h, dpr) => viewports.push([w, h, dpr]),
    retry: () => retries++,
  });
  return {
    posted,
    send: (m: RendererToMain) => send(m),
    controls,
    viewports,
    retries: () => retries,
    startCalls: () => startCalls,
    sink: () => sink,
    bound,
  };
}

test("a viewport goes to its handler, a retry to its handler, and a control to the session", () => {
  const h = harness();

  h.send({ kind: "viewport", width: 400, height: 800, dpr: 1.5 });
  h.send({ kind: "retry" });
  h.send({ kind: "control", intent: { type: "text", text: "x" } });

  expect(h.viewports).toEqual([[400, 800, 1.5]]);
  expect(h.retries()).toBe(1);
  expect(h.controls).toEqual([{ type: "text", text: "x" }]);
});

test("main-window requests from a pop-out are ignored", () => {
  const h = harness();

  h.send({ kind: "popout-open", pkg: "com.example.chat" });
  h.send({ kind: "popout-current" });
  h.send({ kind: "apps-request", id: 1 });
  h.send({ kind: "create-shortcut", pkg: "com.example.chat" });
  h.send({ kind: "drop-files", paths: ["/tmp/a.apk"] });

  expect(h.controls).toEqual([]);
  expect(h.viewports).toEqual([]);
  expect(h.retries()).toBe(0);
  expect(h.posted).toEqual([]);
});

test("the session starts on the first ready, and a repeated ready replays video-start and the configuration packet", async () => {
  const h = harness();
  expect(h.startCalls()).toBe(0);

  h.send({ kind: "ready" });
  await flush();
  expect(h.startCalls()).toBe(1);
  h.sink().videoStart({ codecId: 1, width: 400, height: 800, deviceName: null });
  h.sink().videoPacket({ type: "configuration", data: new Uint8Array([7, 7]) });
  h.sink().videoPacket({ type: "data", keyframe: true, pts: 1, data: new Uint8Array([1]) });

  h.posted.length = 0;
  h.send({ kind: "ready" });
  await flush();

  expect(h.startCalls()).toBe(1);
  expect(h.posted).toEqual([
    { kind: "video-start", info: { codecId: 1, width: 400, height: 800, deviceName: null } },
    { kind: "video-packet", packet: { type: "configuration", data: new Uint8Array([7, 7]) } },
  ]);
});

test("status posts a status message to the window", () => {
  const h = harness();

  h.bound.status({ state: "connecting", serial: "R5CY" });

  expect(h.posted).toEqual([{ kind: "status", status: { state: "connecting", serial: "R5CY" } }]);
});
