import { DecodeRecovery } from "../shared/decode-recovery";
import { bodyIsOpen, FoldDirector, type DirectorOutput } from "../shared/fold-director";
import { classifyScreen, type ScreenClass } from "../shared/fold7";
import { bodySizePx, defaultPxPerMm, deviceAlignedSize, FOLD7_BODY, lerpSize, showcaseSizePx } from "../shared/layout";
import type { Rotation } from "../shared/screen-uv";
import { WindowSizer } from "../shared/window-sizer";
import type { MainToRenderer, SessionStatus } from "../shared/wire";
import { AudioPipe } from "./audio-pipe";
import { createWorkletPlayer } from "./audio/worklet-player";
import { InputRouter } from "./input/input-router";
import { MediaGate } from "./media-gate";
import { PortClient, receivePort } from "./port-client";
import { PhoneScene, type ViewState } from "./scene/phone-scene";
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

const SCENE_READY_CAP_MS = 5000;

async function loadModel(): Promise<ArrayBuffer> {
  const response = await fetch(new URL("fold7.glb", window.location.href));
  if (!response.ok) throw new Error(`fold7.glb: HTTP ${response.status}`);
  return response.arrayBuffer();
}

const director = new FoldDirector({ view: "work" });
const windowSizer = new WindowSizer((size, rotation) => window.hinge.setWindowSize(size.w, size.h, rotation), {
  nudgeLostResizes: window.hinge.platform === "linux",
});
const decodeRecovery = new DecodeRecovery();
let pxPerMm: number | null = null;
let cls: ScreenClass | null = null;
let videoSize: { w: number; h: number } | null = null;
let client: PortClient | null = null;

interface PosePhase {
  atMs: number;
  lit: DirectorOutput["lit"];
  moving: boolean;
  settled: boolean;
  rotation: Rotation;
}

const MAX_PHASES = 500;
const phases: PosePhase[] = [];

/** Keeps each change of lit screen, hinge motion, settling or rotation, for the e2e test to read back. */
function logPhase(out: DirectorOutput, rotation: Rotation): void {
  const last = phases.at(-1);
  const moving = out.angle > 0 && out.angle < 180;
  if (last && last.lit === out.lit && last.moving === moving && last.settled === out.settled && last.rotation === rotation) return;
  phases.push({ atMs: performance.now(), lit: out.lit, moving, settled: out.settled, rotation });
  if (phases.length > MAX_PHASES) phases.shift();
}

function sizeWindow(out: DirectorOutput, rotation: Rotation, view: ViewState): void {
  if (pxPerMm === null) return;
  const work = bodySizePx(FOLD7_BODY, bodyIsOpen(out), rotation, pxPerMm);
  if (view.t === 0 && !view.active) {
    windowSizer.update(deviceAlignedSize(work, window.devicePixelRatio), rotation, out.settled);
    return;
  }
  const size = lerpSize(work, showcaseSizePx(FOLD7_BODY, rotation, pxPerMm), view.t);
  windowSizer.follow(deviceAlignedSize(size, window.devicePixelRatio), rotation);
}

// Checked on a timer rather than per animation frame, which a busy GPU can
// hold off for longer than the check is meant to wait.
setInterval(() => windowSizer.verify({ w: innerWidth, h: innerHeight }, performance.now()), 100);

function onTick(out: DirectorOutput, rotation: Rotation, view: ViewState): void {
  logPhase(out, rotation);
  sizeWindow(out, rotation, view);
}

const scene = new PhoneScene(document.body, director, { loadModel, onTick });

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

const pipe = new VideoPipe(scene, onSize, { onError: onDecodeError, onFirstFrame, onFrame: () => director.frame() });
// audioPipe has no UI surface to report failures through; logged only.
const audioPipe = new AudioPipe({ createPlayer: createWorkletPlayer, onError: (message) => console.error("audio:", message) });

const canvas = document.body.querySelector("canvas");
if (!canvas) throw new Error("PhoneScene did not create a canvas");
new InputRouter(canvas, scene, () => videoSize, (intent) => client?.send({ kind: "control", intent }), {
  onAction: (action) => {
    if (action === "toggle-view") scene.toggleView();
  },
});

// Deliberately minimal: only resolves dropped files to real paths and hands them to main.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const paths = Array.from(files)
    .map((file) => window.hinge.getPathForFile(file))
    .filter((path) => path !== "");
  if (paths.length === 0) return;
  client?.send({ kind: "drop-files", paths });
});

type StreamMessage = Exclude<MainToRenderer, { kind: "status" | "transfer-progress" | "device-command-result" }>;

function onStreamMessage(msg: StreamMessage): void {
  switch (msg.kind) {
    case "video-start":
      pipe.start(msg.info);
      break;
    case "video-packet":
      pipe.push(msg.packet);
      break;
    case "video-end":
      pipe.end();
      director.streamEnded();
      break;
    case "posture":
      director.posture(msg.reading);
      break;
    case "audio-start":
      audioPipe.start(msg.info);
      break;
    case "audio-packet":
      audioPipe.push(msg.packet);
      break;
    case "audio-end":
      audioPipe.end();
      break;
  }
}

const streamGate = new MediaGate(onStreamMessage, scene.ready, SCENE_READY_CAP_MS);

void receivePort().then((port) => {
  client = new PortClient(port);
  client.on((msg) => {
    if (msg.kind === "status") scene.setStatus(statusText(msg.status));
    else if (msg.kind !== "transfer-progress" && msg.kind !== "device-command-result") streamGate.push(msg);
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
      view: scene.view(),
      brightness: { cover: out?.coverBrightness ?? 0, inner: out?.innerBrightness ?? 0 },
    };
  },
  phases: () => [...phases],
};
