import colourwayFile from "../../model/colorways.json";
import { colourwayFor, colourwaySwatches, type ColourwayFile } from "../shared/colourways";
import { DecodeRecovery } from "../shared/decode-recovery";
import { bodyIsOpen, FoldDirector, type DirectorOutput } from "../shared/fold-director";
import { classifyScreen, type ScreenClass } from "../shared/fold7";
import { bodySizePx, deviceAlignedPad, deviceAlignedSize, FOLD7_BODY, NO_PAD, unionSize } from "../shared/layout";
import type { Rotation } from "../shared/screen-uv";
import { startupDevice, type Settings } from "../shared/settings";
import { defaultModifiers, normaliseModifiers, type HingeAction } from "../shared/shortcuts";
import { TurnRoom } from "../shared/turn-room";
import { WindowSizer } from "../shared/window-sizer";
import type { MainToRenderer, SessionStatus } from "../shared/wire";
import { AudioPipe } from "./audio-pipe";
import { createWorkletPlayer } from "./audio/worklet-player";
import { Chrome } from "./chrome/chrome";
import { DeviceCommands } from "./chrome/device-commands";
import { bodyRectIn, MENU_EDGE_PX, topBezelMm, type Box, type Size } from "./chrome/hit-zone";
import { transferToast } from "./chrome/toast-text";
import { InputRouter } from "./input/input-router";
import { MediaGate } from "./media-gate";
import { PausableTarget } from "./pausable-target";
import { PortClient, receivePort } from "./port-client";
import { ScaleController } from "./scale-controller";
import { RotationMemory } from "./rotation-memory";
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

const director = new FoldDirector({
  requestFrames: () => client?.send({ kind: "control", intent: { type: "reset-video" } }),
});
const windowSizer = new WindowSizer((size, rotation, pad) => window.hinge.setWindowSize(size.w, size.h, rotation, pad), {
  nudgeLostResizes: window.hinge.platform === "linux",
});
const heldRoom = new TurnRoom();
const decodeRecovery = new DecodeRecovery();
const colourways = colourwayFile as ColourwayFile;
let cls: ScreenClass | null = null;
let videoSize: { w: number; h: number } | null = null;
let client: PortClient | null = null;
let settings: Settings | null = null;
let currentSerial: string | null = null;
let currentDeviceId: string | null = null;
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
 * In fullscreen the window is the whole screen, so straight on the canvas
 * (still anchored to the fixed half's edge) is placed within a stage the
 * size of the body, centred on the screen; a transformed stage is what
 * position: fixed inside it resolves against. The showcase look frames the
 * phone in the middle of the canvas, so as the phone turns the stage grows
 * with the blend until it covers the whole window.
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

function lerpBox(a: Box, b: Box, t: number): Box {
  const at = (from: number, to: number) => from + (to - from) * t;
  return { x: at(a.x, b.x), y: at(a.y, b.y), w: at(a.w, b.w), h: at(a.h, b.h) };
}

function fullscreenStage(body: Box, viewport: Size, view: ViewState): Box | null {
  return view.t >= 1 ? null : lerpBox(body, { x: 0, y: 0, ...viewport }, view.t);
}

/**
 * The hover menu, its panels and the toasts hang off the phone's top bezel
 * straight on. Once the phone turns it is tilted and moving, so the chrome
 * anchors to the window instead: the menu at the top centre, over a band
 * the depth of the work view's menu zone.
 */
function chromeAnchor(body: Box, viewport: Size, bezelPx: number, view: ViewState): { body: Box; bezelPx: number } {
  if (view.t === 0) return { body, bezelPx };
  return { body: { x: 0, y: 0, ...viewport }, bezelPx: MENU_EDGE_PX };
}

function withPanel(size: Size, panel: Size | null, dpr: number): Size {
  return panel ? deviceAlignedSize(unionSize(size, panel), dpr) : size;
}

function sizeWindow(out: DirectorOutput, rotation: Rotation, view: ViewState): void {
  const viewport = { w: innerWidth, h: innerHeight };
  if (fullscreen) {
    scale.fitFullscreen(rotation, viewport);
    scene.setWorkSize(null);
  }
  const pxPerMm = scale.pxPerMm;
  if (pxPerMm === null) return;
  const open = bodyIsOpen(out);
  const size = bodySizePx(FOLD7_BODY, open, rotation, pxPerMm);
  const body = bodyRectIn(viewport, size, rotation, fullscreen);
  placeStage(fullscreen ? fullscreenStage(body, viewport, view) : null);
  const bezelPx = topBezelMm(FOLD7_BODY, open, rotation, scene.screenSizeMm(open ? "inner" : "cover")) * pxPerMm;
  chrome.update({ window: viewport, pxPerMm, ...chromeAnchor(body, viewport, bezelPx, view) }, performance.now());
  if (fullscreen) return;

  const dpr = window.devicePixelRatio;
  const work = withPanel(deviceAlignedSize(size, dpr), chrome.neededWindow(), dpr);
  const showcase = view.t > 0 || view.active;
  if (!showcase) heldRoom.release();
  const room = showcase ? deviceAlignedPad(work, heldRoom.update({ need: scene.turnRoom(), straightOn: scene.straightOn() }, scene.turnReserve(), performance.now()), dpr) : NO_PAD;
  windowSizer.update(work, rotation, out.settled, room);
  scene.setWorkSize(showcase ? windowSizer.requested : null);
}

// Checked on a timer rather than per animation frame, which a busy GPU can
// hold off for longer than the check is meant to wait.
setInterval(() => windowSizer.verify({ w: innerWidth, h: innerHeight }, performance.now()), 100);

let lastTickAt: number | null = null;

function onTick(out: DirectorOutput, rotation: Rotation, view: ViewState): void {
  const now = performance.now();
  scale.tick(lastTickAt === null ? 0 : now - lastTickAt);
  lastTickAt = now;
  logPhase(out, rotation);
  sizeWindow(out, rotation, view);
}

const scene = new PhoneScene(stage, director, { loadModel, onTick });

const scale = new ScaleController({
  apply: (pxPerMm) => scene.setPxPerMm(pxPerMm),
  persist: (pxPerMm) => {
    if (currentDeviceId) void window.hinge.saveDeviceSettings(currentDeviceId, { pxPerMm });
  },
});
function readWorkArea(): void {
  void window.hinge.workArea().then(({ width, height }) => {
    if (width > 0 && height > 0) scale.setWorkArea({ w: width, h: height });
  });
}
readWorkArea();
window.hinge.onWorkAreaChanged(readWorkArea);

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

const rotations = new RotationMemory({
  angles: () => scene.modelRotation(),
  set: (angles) => scene.setModelRotation(angles),
  springToRest: () => scene.resetModelRotation(),
  save: (id, rotation) => void window.hinge.saveDeviceSettings(id, { rotation }),
});

/**
 * Held back until the settings are in, so the first phone's saved scale and
 * turn are known when its streaming status arrives; later settings
 * changes never touch them, which only change on a device change. The last
 * phone's are applied at once, so the window does not jump when it starts
 * streaming.
 */
const settingsReady = window.hinge
  .settings()
  .catch(() => null)
  .then((loaded: Settings | null) => {
    if (loaded && !settings) applySettings(loaded);
    const last = loaded ? startupDevice(loaded) : null;
    if (last) scale.useDevice(last.id, last.saved.pxPerMm);
    if (last) rotations.useDevice(last.id, last.saved.rotation);
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
  currentDeviceId = status.deviceId;
  const saved = settings?.devices[status.deviceId];
  scale.useDevice(status.deviceId, saved?.pxPerMm);
  rotations.useDevice(status.deviceId, saved?.rotation);
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
const pipe = new VideoPipe(display, onSize, { onError: onDecodeError, onFirstFrame, onFrame: () => director.frame() });
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
    case "center":
      rotations.reset();
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

const router = new InputRouter(canvas, scene, () => videoSize, (intent) => client?.send({ kind: "control", intent }), {
  onAction,
  modifiers: () => normaliseModifiers(settings?.shortcutModifiers, defaultModifiers(window.hinge.platform)),
  paused: () => display.paused,
  onRotated: (outcome) => (outcome === "reset" ? rotations.reset() : rotations.turned(scene.modelRotation())),
  scrolling: () => ({ smoothingMs: settings?.scrollSmoothing ?? 0, speed: settings?.scrollSpeed ?? 1, style: settings?.wheelStyle ?? "swipe" }),
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

type StreamMessage = Exclude<MainToRenderer, { kind: "status" | "transfer-progress" | "device-command-result" | "devices" }>;

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
      else if (msg.reason === "error") chrome.toast({ id: "audio", text: "Phone audio stopped", tone: "error" });
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
    else if (msg.kind === "devices") chrome.devicesChanged(msg.devices);
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
      view: scene.view(),
      brightness: { cover: out?.coverBrightness ?? 0, inner: out?.innerBrightness ?? 0 },
      pxPerMm: scale.pxPerMm,
      scaling: scale.easing,
      paused: display.paused,
      modelRotation: scene.modelRotation(),
      turn: scene.turnState(),
    };
  },
  phases: () => [...phases],
  streamPointAt: (x: number, y: number) => router.streamPointAt(x, y),
  pressAt: (x: number, y: number) => router.pressAt(x, y),
  drop: (paths: string[]) => client?.send({ kind: "drop-files", paths }),
};
