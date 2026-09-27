import { DecodeRecovery } from "../../shared/decode-recovery";
import { displayGeometry } from "../../shared/popout";
import type { Settings } from "../../shared/settings";
import { defaultModifiers, normaliseModifiers } from "../../shared/shortcuts";
import type { MainToRenderer, SessionStatus } from "../../shared/wire";
import { PortClient, receivePort } from "../port-client";
import { paintStatus } from "../status-paint";
import { statusText } from "../status-text";
import type { FrameTarget } from "../texture-renderer";
import { VideoPipe } from "../video-pipe";
import { FlatInput, videoRectIn, type VideoRect } from "./flat-input";

/** Holds the latest decoded frame, closing the one it replaces, so a resize or a status can redraw it. */
class LatestFrame implements FrameTarget {
  disposed = false;
  /** Every frame of the window's life, across streams. */
  received = 0;
  #frame: VideoFrame | null = null;

  constructor(private readonly changed: () => void) {}

  get current(): VideoFrame | null {
    return this.#frame;
  }

  setFrame(frame: VideoFrame): void {
    this.#frame?.close();
    this.#frame = frame;
    this.received++;
    this.changed();
  }

  /** The last frame stays up under a "Reconnecting…" overlay. */
  end(): void {}
}

const canvas = document.createElement("canvas");
document.body.append(canvas);
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d canvas context unavailable");

const retryButton = document.createElement("button");
retryButton.dataset.retry = "";
retryButton.textContent = "Retry";
retryButton.hidden = true;
document.body.append(retryButton);

let client: PortClient | null = null;
let settings: Settings | null = null;
let videoSize: { w: number; h: number } | null = null;
let viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
let shownStatus: string | null = "Connecting…";
let streamedOnce = false;
let drawQueued = false;

function onStatus(status: SessionStatus): void {
  shownStatus = statusText(status, streamedOnce ? "Reconnecting…" : "Connecting…");
  retryButton.hidden = status.state !== "error";
  requestDraw();
}

/**
 * The stream only fits the canvas once the phone has resized its display to
 * the window; until then (mid-drag) the last frame is stretched to the
 * canvas rather than shown between bars.
 */
function fitted(): boolean {
  const wanted = displayGeometry(viewport.width, viewport.height, viewport.dpr);
  return videoSize !== null && wanted !== null && wanted.width === videoSize.w && wanted.height === videoSize.h;
}

function frameRect(): VideoRect {
  if (!videoSize || !fitted()) return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  return videoRectIn(canvas.width, canvas.height, videoSize.w, videoSize.h);
}

function draw(): void {
  drawQueued = false;
  if (!ctx) return;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const frame = frames.current;
  if (frame) {
    const rect = frameRect();
    ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
  }
  if (shownStatus !== null) paintStatus(ctx, shownStatus, canvas.width, canvas.height);
}

function requestDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function sendViewport(): void {
  client?.send({ kind: "viewport", ...viewport });
}

function onViewportChanged(): void {
  viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
  canvas.width = Math.max(1, Math.round(viewport.width * viewport.dpr));
  canvas.height = Math.max(1, Math.round(viewport.height * viewport.dpr));
  sendViewport();
  requestDraw();
}

const frames = new LatestFrame(requestDraw);
const decodeRecovery = new DecodeRecovery();
const pipe = new VideoPipe(
  frames,
  (w, h) => {
    videoSize = { w, h };
  },
  {
    onFirstFrame: () => {
      streamedOnce = true;
    },
    onError: (message) => {
      if (decodeRecovery.onError(performance.now()) === "reset") client?.send({ kind: "control", intent: { type: "reset-video" } });
      else onStatus({ state: "error", message: `Video error: ${message}` });
    },
  },
);

new FlatInput(canvas, () => videoSize, (intent) => client?.send({ kind: "control", intent }), {
  modifiers: () => normaliseModifiers(settings?.shortcutModifiers, defaultModifiers(window.hinge.platform)),
  scrolling: () => ({ smoothingMs: settings?.scrollSmoothing ?? 0, speed: settings?.scrollSpeed ?? 1, style: settings?.wheelStyle ?? "swipe" }),
  fitted,
});

retryButton.addEventListener("click", () => {
  retryButton.hidden = true;
  client?.send({ kind: "retry" });
});

new ResizeObserver(onViewportChanged).observe(document.body);
onViewportChanged();

void window.hinge
  .settings()
  .catch(() => null)
  .then((loaded: Settings | null) => {
    if (loaded && !settings) settings = loaded;
  });
window.hinge.onSettings((next) => {
  settings = next;
});

function onMessage(msg: MainToRenderer): void {
  switch (msg.kind) {
    case "status":
      onStatus(msg.status);
      break;
    case "video-start":
      pipe.start(msg.info);
      break;
    case "video-packet":
      pipe.push(msg.packet);
      break;
    case "video-end":
      pipe.end();
      break;
  }
}

void receivePort().then((port) => {
  client = new PortClient(port);
  client.on(onMessage);
  client.send({ kind: "ready" });
  sendViewport();
});

(window as unknown as { __hingePopout: unknown }).__hingePopout = {
  get framesDecoded() {
    return frames.received;
  },
  get videoSize() {
    return videoSize;
  },
  get viewport() {
    return viewport;
  },
};
