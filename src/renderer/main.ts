import { DecodeRecovery } from "../shared/decode-recovery";
import { FoldDirector, type DirectorOutput } from "../shared/fold-director";
import { classifyScreen, type ScreenClass } from "../shared/fold7";
import { bodySizePx, defaultPxPerMm, FOLD7_BODY } from "../shared/layout";
import type { Rotation } from "../shared/screen-uv";
import { WindowSizer } from "../shared/window-sizer";
import type { SessionStatus } from "../shared/wire";
import { InputRouter } from "./input/input-router";
import { PortClient, receivePort } from "./port-client";
import { PhoneScene } from "./scene/phone-scene";
import { VideoPipe } from "./video-pipe";

function statusText(status: SessionStatus): string | null {
  switch (status.state) {
    case "no-device":
      return "Connect your phone";
    case "unauthorized":
      return "Allow USB debugging on your phone";
    case "connecting":
      return "Connecting...";
    case "error":
      return status.message;
    case "streaming":
    case "replay":
      return null;
  }
}

async function loadModel(): Promise<ArrayBuffer> {
  const response = await fetch(new URL("fold7.glb", window.location.href));
  if (!response.ok) throw new Error(`fold7.glb: HTTP ${response.status}`);
  return response.arrayBuffer();
}

const director = new FoldDirector({ view: "work" });
const windowSizer = new WindowSizer((size, rotation) => window.hinge.setWindowSize(size.w, size.h, rotation));
const decodeRecovery = new DecodeRecovery();
let pxPerMm: number | null = null;
let cls: ScreenClass | null = null;
let videoSize: { w: number; h: number } | null = null;
let client: PortClient | null = null;

/** The window covers the model's current pose: open once the inner screen is lit or the hinge has started to move. */
function sizeWindow(out: DirectorOutput, rotation: Rotation): void {
  if (pxPerMm === null) return;
  const open = out.lit === "inner" || out.angle > 1;
  windowSizer.update(bodySizePx(FOLD7_BODY, open, rotation, pxPerMm), rotation, out.settled);
}

// Checked on a timer rather than per animation frame, which a busy GPU can
// hold off for longer than the check is meant to wait.
setInterval(() => windowSizer.verify({ w: innerWidth, h: innerHeight }, performance.now()), 100);

const scene = new PhoneScene(document.body, director, { loadModel, onTick: sizeWindow });

void window.hinge.workAreaHeight().then((height) => {
  pxPerMm = defaultPxPerMm(FOLD7_BODY, height);
  scene.setPxPerMm(pxPerMm);
});

function onSize(w: number, h: number): void {
  videoSize = { w, h };
  cls = classifyScreen(w, h, cls);
  director.streamClass(cls);
  scene.streamClass(cls);
}

function onFirstFrame(): void {
  director.firstFrame();
  scene.firstFrameOfClass();
}

function onDecodeError(message: string): void {
  if (decodeRecovery.onError(performance.now()) === "reset") client?.send({ kind: "control", intent: { type: "reset-video" } });
  else scene.setStatus(`Video error: ${message}`);
}

const pipe = new VideoPipe(scene, onSize, { onError: onDecodeError, onFirstFrame });

const canvas = document.body.querySelector("canvas");
if (!canvas) throw new Error("PhoneScene did not create a canvas");
new InputRouter(canvas, scene, () => videoSize, (intent) => client?.send({ kind: "control", intent }));

void Promise.all([receivePort(), scene.ready]).then(([port]) => {
  client = new PortClient(port);
  client.on((msg) => {
    if (msg.kind === "video-start") pipe.start(msg.info);
    else if (msg.kind === "video-packet") pipe.push(msg.packet);
    else if (msg.kind === "video-end") {
      pipe.end();
      director.streamEnded();
    } else if (msg.kind === "status") scene.setStatus(statusText(msg.status));
    else if (msg.kind === "posture") director.posture(msg.reading);
  });
  client.send({ kind: "ready" });
});

(window as unknown as { __hinge: unknown }).__hinge = {
  stats: () => {
    const out = scene.output();
    return {
      ...pipe.stats(),
      cls,
      window: { w: innerWidth, h: innerHeight },
      angle: out?.angle ?? null,
      lit: out?.lit ?? null,
      rotation: scene.rotation(),
      badge: out?.badge ?? null,
      settled: out?.settled ?? false,
    };
  },
};
