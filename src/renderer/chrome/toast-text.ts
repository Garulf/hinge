import type { DeviceCommandResult, TransferProgress } from "../../shared/wire";
import type { ToastInput } from "./toast-queue";

const VERB = {
  install: { running: "Installing", done: "Installed", failed: "Could not install" },
  push: { running: "Sending", done: "Sent", failed: "Could not send" },
} as const;

function shortError(message: string | undefined): string {
  return (message ?? "unknown error").replace(/^Error:\s*/, "").split("\n")[0];
}

/** One toast per transfer, updated in place as it moves from queued to running to its result. */
export function transferToast(p: TransferProgress): ToastInput {
  const verb = VERB[p.kind];
  const id = `transfer-${p.id}`;
  const where = p.kind === "push" ? " to Download" : "";
  switch (p.state) {
    case "queued":
      return { id, text: `Waiting to send ${p.name}`, sticky: true };
    case "running": {
      const progress = p.totalBytes > 0 ? p.bytesWritten / p.totalBytes : 0;
      return { id, text: `${verb.running} ${p.name} ${Math.round(progress * 100)}%`, progress, sticky: true };
    }
    case "done":
      return { id, text: `${verb.done} ${p.name}${where}` };
    case "cancelled":
      return { id, text: `Cancelled ${p.name}` };
    case "error":
      return { id, text: `${verb.failed} ${p.name}: ${shortError(p.message)}`, tone: "error" };
  }
}

/** A toast for a device panel command's outcome; listing the devices needs none. */
export function deviceResultToast(result: DeviceCommandResult): ToastInput | null {
  switch (result.type) {
    case "list":
      return null;
    case "pair":
      if (!result.ok) return { text: `Pairing failed: ${shortError(result.message)}`, tone: "error" };
      return { text: result.connectedAddress ? `Paired and connected to ${result.connectedAddress}` : "Paired. Enter the connect port shown on the phone." };
    case "connect":
      return result.ok ? { text: "Connecting..." } : { text: `Could not connect: ${shortError(result.message)}`, tone: "error" };
    case "switch-to-wifi":
      return result.ok ? { text: `Switched to Wi-Fi at ${result.address}` } : { text: `Could not switch to Wi-Fi: ${shortError(result.message)}`, tone: "error" };
    case "disconnect":
      return result.ok ? { text: "Disconnected" } : { text: `Could not disconnect: ${shortError(result.message)}`, tone: "error" };
  }
}
