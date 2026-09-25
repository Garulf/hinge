import { classifyScreen, FOLD7, type ScreenClass } from "../shared/fold7";
import { defaultScale, workLayout } from "../shared/layout";
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

const scene = new PhoneScene(document.body);
let cls: ScreenClass | null = null;
let scale: number | null = null;
let videoSize: { w: number; h: number } | null = null;
let client: PortClient | null = null;

async function onSize(w: number, h: number): Promise<void> {
  videoSize = { w, h };
  cls = classifyScreen(w, h, cls);
  scale ??= defaultScale(w, h, cls, await window.hinge.workAreaHeight());
  const layout = workLayout(w, h, cls, scale);
  scene.applyLayout(layout);
  window.hinge.setContentSize(layout.window.w, layout.window.h);
}

const pipe = new VideoPipe(scene, (w, h) => void onSize(w, h), {
  onError: (message) => scene.setStatus(`Video error: ${message}`),
});

const canvas = document.body.querySelector("canvas");
if (!canvas) throw new Error("PhoneScene did not create a canvas");
new InputRouter(canvas, scene, () => videoSize, (intent) => client?.send({ kind: "control", intent }));

/**
 * Before the first frame there is no stream size to lay out from, so the
 * window and overlay would otherwise sit at their raw BrowserWindow default
 * (an odd, wrongly proportioned box that can't even be dragged sensibly).
 * Lay out for the cover screen, portrait, at the usual default scale so the
 * first status the user sees renders at a normal size and DPR.
 */
async function applyPlaceholderLayout(): Promise<void> {
  const placeholderCls: ScreenClass = { screen: "cover", rotated: false };
  const spec = FOLD7[placeholderCls.screen];
  const workAreaHeight = await window.hinge.workAreaHeight();
  const placeholderScale = defaultScale(spec.px.w, spec.px.h, placeholderCls, workAreaHeight);
  const layout = workLayout(spec.px.w, spec.px.h, placeholderCls, placeholderScale);
  scene.applyLayout(layout);
  window.hinge.setContentSize(layout.window.w, layout.window.h);
}
void applyPlaceholderLayout();

void receivePort().then((port) => {
  client = new PortClient(port);
  client.on((msg) => {
    if (msg.kind === "video-start") pipe.start(msg.info);
    else if (msg.kind === "video-packet") pipe.push(msg.packet);
    else if (msg.kind === "video-end") pipe.end();
    else if (msg.kind === "status") scene.setStatus(statusText(msg.status));
  });
  client.send({ kind: "ready" });
});

(window as unknown as { __hinge: unknown }).__hinge = {
  stats: () => ({ ...pipe.stats(), cls, window: { w: innerWidth, h: innerHeight } }),
};
