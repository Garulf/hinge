import type { SessionStatus } from "../shared/wire";

export type TransportKind = "usb" | "tcp" | "mdns";

export interface DeviceSummary {
  serial: string;
  state: string;
  model: string | null;
  transport: TransportKind;
}

export function transportOf(serial: string): TransportKind {
  if (serial.includes("._adb-tls-connect._tcp") || serial.includes("._adb._tcp")) return "mdns";
  if (/:\d+$/.test(serial)) return "tcp";
  return "usb";
}

export function deviceStatus(device: DeviceSummary | undefined): SessionStatus | null {
  if (!device) return { state: "no-device" };
  if (device.state === "unauthorized" || device.state === "authorizing") {
    return { state: "unauthorized", serial: device.serial };
  }
  if (device.state !== "device") return { state: "connecting", serial: device.serial };
  return null;
}

export function pickDevice(devices: DeviceSummary[], preferredSerial: string | null): DeviceSummary | undefined {
  const candidates = devices.filter(
    (d) => d.state === "device" || d.state === "unauthorized" || d.state === "authorizing",
  );
  if (preferredSerial !== null) {
    const preferred = candidates.find((d) => d.serial === preferredSerial);
    if (preferred) return preferred;
  }
  const usb = candidates.find((d) => d.transport === "usb");
  if (usb) return usb;
  return candidates[0];
}
