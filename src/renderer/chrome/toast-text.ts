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

export interface DeviceMessage {
  text: string;
  tone: "info" | "error";
}

const info = (text: string): DeviceMessage => ({ text, tone: "info" });
const error = (text: string): DeviceMessage => ({ text, tone: "error" });

/** What the Devices panel says, in its own status line, before sending a pairing request it can already tell is wrong. */
export const PAIR_INPUT_MESSAGES = {
  hostPort: error("Enter the IP address and port shown under the pairing code, like 192.168.1.20:37099"),
  code: error("The pairing code is the 6 digits shown on the phone"),
  connectPort: error("Enter the port shown on the Wireless debugging screen"),
} as const;

/** A device panel command's outcome, for the panel's status line (and a toast when it worked); listing the devices needs none. */
export function deviceResultMessage(result: DeviceCommandResult): DeviceMessage | null {
  switch (result.type) {
    case "list":
      return null;
    case "pair":
      if (!result.ok) return error(`Pairing failed: ${shortError(result.message)}`);
      if (result.connectedAddress) return info(`Paired and connected to ${result.connectedAddress}`);
      if (result.message) return error(`Paired, but connecting failed: ${shortError(result.message)}. Enter the connect port shown on the phone.`);
      return info("Paired. Enter the connect port shown on the phone's Wireless debugging screen.");
    case "connect":
      return result.ok ? info("Connecting...") : error(`Could not connect: ${shortError(result.message)}`);
    case "switch-to-wifi":
      return result.ok ? info(`Switched to Wi-Fi at ${result.address}`) : error(`Could not switch to Wi-Fi: ${shortError(result.message)}`);
    case "disconnect":
      return result.ok ? info("Disconnected") : error(`Could not disconnect: ${shortError(result.message)}`);
  }
}
