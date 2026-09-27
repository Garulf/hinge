import type { RendererToMain, SessionStatus } from "../shared/wire";
import { bindSource, type PortLike } from "./app-controller";
import type { PopoutManagerDeps, PopoutSessionLike } from "./popout-manager";

type PopoutHandlers = Parameters<PopoutManagerDeps["bindPort"]>[2];

/** A pop-out's renderer only streams and drives its one app; everything else it could send belongs to the main window. */
function streamOnly(port: PortLike, handlers: PopoutHandlers): PortLike {
  return {
    postMessage: (msg, transfer) => port.postMessage(msg, transfer),
    onMessage: (fn) =>
      port.onMessage((msg: RendererToMain) => {
        if (msg.kind === "viewport") handlers.viewport(msg.width, msg.height, msg.dpr);
        else if (msg.kind === "retry") handlers.retry();
        else if (msg.kind === "ready" || msg.kind === "control") fn(msg);
      }),
  };
}

export function bindPopoutPort(session: PopoutSessionLike, port: PortLike, handlers: PopoutHandlers): { status(s: SessionStatus): void } {
  const sink = bindSource(session, streamOnly(port, handlers));
  return { status: (s) => sink.status(s) };
}
