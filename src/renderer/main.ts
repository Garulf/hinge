import colourwayFile from "../../model/colorways.json";
import { colourwayFor, colourwaySwatches, type ColourwayFile } from "../shared/colourways";
import { DecodeRecovery } from "../shared/decode-recovery";
import { bodyIsOpen, FoldDirector, type DirectorOutput } from "../shared/fold-director";
import { classifyScreen, type ScreenClass } from "../shared/fold7";
import { bodySizePx, deviceAlignedSize, FOLD7_BODY, unionSize } from "../shared/layout";
import type { Rotation } from "../shared/screen-uv";
import type { Settings } from "../shared/settings";
import { normaliseModifiers, type HingeAction } from "../shared/shortcuts";
import { WindowSizer } from "../shared/window-sizer";
import type { MainToRenderer, SessionStatus } from "../shared/wire";
import { AudioPipe } from "./audio-pipe";
import { createWorkletPlayer } from "./audio/worklet-player";
import { Chrome } from "./chrome/chrome";
import { DeviceCommands } from "./chrome/device-commands";
import { bodyRectIn, type Box } from "./chrome/hit-zone";
import { transferToast } from "./chrome/toast-text";
import { InputRouter } from "./input/input-router";
import { MediaGate } from "./media-gate";
import { PausableTarget } from "./pausable-target";
import { PortClient, receivePort } from "./port-client";
import { ScaleController } from "./scale-controller";
import { ViewMemory } from "./view-memory";
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
const colourways = colourwayFile as ColourwayFile;
let cls: ScreenClass | null = null;
let videoSize: { w: number; h: number } | null = null;
let client: PortClient | null = null;
let settings: Settings | null = null;
let currentSerial: string | null = null;
let fullscreen = false;
let sessionState: SessionStatus["state"] = "no-device";

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

/**
 * In fullscreen the window is the whole screen, so the canvas (still anchored
 * to the fixed half's edge) is placed within a stage the size of the body,
 * centred on the screen; a transformed stage is what position: fixed inside
 * it resolves against.
 */
const stage = document.createElement("div");
document.body.append(stage);
let stageBox = "";

function placeStage(box: Box | null): void {
  const next = box ? `left: ${box.x}px; top: ${box.y}px; width: ${box.w}px; height: ${box.h}px;` : "inset: 0;";
  if (next === stageBox) return;
  stageBox = next;
  stage.style.cssText = `position: fixed; transform: translateZ(0); ${next}`;
}
placeStage(null);

function sizeWindow(out: DirectorOutput, rotation: Rotation): void {
  if (fullscreen) scale.fitFullscreen(rotation, { w: innerWidth, h: innerHeight });
  const pxPerMm = scale.pxPerMm;
  if (pxPerMm === null) return;
  const open = bodyIsOpen(out);
  const size = bodySizePx(FOLD7_BODY, open, rotation, pxPerMm);
  const viewport = { w: innerWidth, h: innerHeight };
  const body = bodyRectIn(viewport, size, rotation, fullscreen);
  placeStage(fullscreen ? body : null);
  chrome.update({ window: viewport, body, pxPerMm }, performance.now());
  if (fullscreen) return;
  const panel = chrome.neededWindow();
  windowSizer.update(deviceAlignedSize(panel ? unionSize(size, panel) : size, window.devicePixelRatio), rotation, out.settled);
}

// Checked on a timer rather than per animation frame, which a busy GPU can
// hold off for longer than the check is meant to wait.
setInterval(() => windowSizer.verify({ w: innerWidth, h: innerHeight }, performance.now()), 100);

function onTick(out: DirectorOutput, rotation: Rotation): void {
  logPhase(out, rotation);
  sizeWindow(out, rotation);
}

const scene = new PhoneScene(stage, director, { loadModel, onTick });

const scale = new ScaleController({
  apply: (pxPerMm) => scene.setPxPerMm(pxPerMm),
  persist: (pxPerMm) => {
    if (currentSerial) void window.hinge.saveDeviceSettings(currentSerial, { pxPerMm });
  },
});
void window.hinge.workAreaHeight().then((height) => scale.setWorkArea(height));

const commands = new DeviceCommands((msg) => client?.send(msg));
const chrome = new Chrome(document.body, {
  commands,
  swatches: colourwaySwatches(colourways),
  save: (patch) => void window.hinge.saveSettings(patch),
  settingsPath: () => window.hinge.settingsPath(),
  onAction: (action) => onAction(action),
  currentSerial: () => currentSerial,
});

function applySettings(next: Settings): void {
  settings = next;
  scene.setColourway(colourwayFor(colourways, next.colourway).materials);
  chrome.settingsChanged(next);
}

let views: ViewMemory | null = null;

/**
 * Held back until the settings are in, so the first phone's saved scale and
 * view are known when its streaming status arrives; later settings changes
 * never touch scale or view, which only change on a device change.
 */
const settingsReady = window.hinge
  .settings()
  .catch(() => null)
  .then((loaded: Settings | null) => {
    if (loaded && !settings) applySettings(loaded);
    views = new ViewMemory(
      {
        apply: (view) => director.setView(view),
        save: (serial, view) => {
          void window.hinge.saveSettings({ view });
          if (serial) void window.hinge.saveDeviceSettings(serial, { view });
        },
      },
      loaded?.view ?? "work",
    );
  });
window.hinge.onSettings(applySettings);

window.hinge.onFullscreen((on) => {
  fullscreen = on;
  document.body.style.background = on ? "#000" : "";
  if (!on) scale.leaveFullscreen();
});

function onStatus(status: SessionStatus): void {
  sessionState = status.state;
  scene.setStatus(statusText(status));
  if (status.state !== "streaming") return;
  currentSerial = status.serial;
  const saved = settings?.devices[status.serial];
  scale.useDevice(status.serial, saved?.pxPerMm);
  views?.useDevice(status.serial, saved?.view);
}

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

const display = new PausableTarget(scene);
const pipe = new VideoPipe(display, onSize, { onError: onDecodeError, onFirstFrame });
const audioPipe = new AudioPipe({
  createPlayer: createWorkletPlayer,
  onError: (message) => {
    console.error("audio:", message);
    chrome.toast({ id: "audio", text: `Phone audio stopped: ${message}`, tone: "error" });
  },
});

const canvas = stage.querySelector("canvas");
if (!canvas) throw new Error("PhoneScene did not create a canvas");
let fpsTimer: ReturnType<typeof setInterval> | null = null;

/** scrcpy prints its FPS counter to stdout; hinge draws it on the bottom bezel. */
function toggleFps(): void {
  if (fpsTimer !== null) {
    clearInterval(fpsTimer);
    fpsTimer = null;
    chrome.setFps(null);
    return;
  }
  let lastFrames = pipe.stats().framesDecoded;
  let lastAt = performance.now();
  chrome.setFps("-- fps");
  fpsTimer = setInterval(() => {
    const frames = pipe.stats().framesDecoded;
    const now = performance.now();
    chrome.setFps(`${Math.max(0, Math.round(((frames - lastFrames) * 1000) / (now - lastAt)))} fps`);
    lastFrames = frames;
    lastAt = now;
  }, 1000);
}

function scaleBy(direction: 1 | -1): void {
  if (scale.step(direction)) chrome.toast({ id: "scale", text: `Scale ${scale.percent()}%` });
}

function pixelPerfect(): void {
  const lit = scene.output()?.lit ?? null;
  if (scale.pixelPerfect(videoSize, lit ? scene.screenSizeMm(lit) : null, window.devicePixelRatio)) chrome.toast({ id: "scale", text: "Scale 1:1" });
}

function onAction(action: HingeAction): void {
  switch (action) {
    case "toggle-view":
      views?.toggle();
      break;
    case "quit":
      window.hinge.quit();
      break;
    case "pause":
      display.paused = true;
      chrome.toast({ id: "pause", text: "Display paused. MOD+Shift+z resumes.", sticky: true });
      break;
    case "unpause":
      if (!display.paused) break;
      display.paused = false;
      chrome.toast({ id: "pause", text: "Display resumed" });
      break;
    case "fullscreen":
      window.hinge.toggleFullscreen();
      break;
    case "pixel-perfect":
      pixelPerfect();
      break;
    case "fit":
      chrome.closePanel();
      break;
    case "toggle-fps":
      toggleFps();
      break;
    case "scale-up":
      scaleBy(1);
      break;
    case "scale-down":
      scaleBy(-1);
      break;
  }
}

new InputRouter(canvas, scene, () => videoSize, (intent) => client?.send({ kind: "control", intent }), {
  onAction,
  modifiers: () => normaliseModifiers(settings?.shortcutModifiers),
  paused: () => display.paused,
});

// Resolves dropped files to real paths and hands them to main, which picks install or push.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const paths = Array.from(files)
    .map((file) => window.hinge.getPathForFile(file))
    .filter((path) => path !== "");
  if (paths.length === 0) return;
  if (sessionState !== "streaming" && sessionState !== "replay") {
    chrome.toast({ text: "Connect the phone to send it files", tone: "error" });
    return;
  }
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
      if (msg.reason === "unsupported") chrome.toast({ id: "audio", text: "This phone cannot share its audio; mirroring without sound" });
      break;
  }
}

const streamGate = new MediaGate(onStreamMessage, scene.ready, SCENE_READY_CAP_MS);

void Promise.all([receivePort(), settingsReady]).then(([port]) => {
  client = new PortClient(port);
  client.on((msg) => {
    if (msg.kind === "status") onStatus(msg.status);
    else if (msg.kind === "transfer-progress") chrome.toast(transferToast(msg.progress));
    else if (msg.kind === "device-command-result") commands.result(msg.id, msg.result);
    else streamGate.push(msg);
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
      brightness: { cover: out?.coverBrightness ?? 0, inner: out?.innerBrightness ?? 0 },
      pxPerMm: scale.pxPerMm,
      paused: display.paused,
    };
  },
  phases: () => [...phases],
  drop: (paths: string[]) => client?.send({ kind: "drop-files", paths }),
};
