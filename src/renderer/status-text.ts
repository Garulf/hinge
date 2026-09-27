import type { SessionStatus } from "../shared/wire";

/** What a window shows over the video for a session status, or null to show the video alone. */
export function statusText(status: SessionStatus, connecting: string): string | null {
  switch (status.state) {
    case "no-device":
      return "Connect your phone";
    case "unauthorized":
      return "Allow USB debugging on your phone";
    case "connecting":
      return connecting;
    case "error":
      return status.message;
    case "streaming":
    case "replay":
      return null;
  }
}
