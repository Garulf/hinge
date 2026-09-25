import type { DeviceSummary, SessionStatus, TransportKind } from "../shared/wire";

export type { DeviceSummary, TransportKind };

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

const TRANSPORT_RANK: Record<TransportKind, number> = { usb: 0, tcp: 1, mdns: 2 };

/**
 * Collapses the same physical phone when it is listed twice (its ip:port
 * transport entry and its mDNS-discovered serial), keyed by model+device
 * since neither transport alone identifies the phone. Devices missing
 * either field are left alone rather than risking merging two different
 * phones with unknown metadata. Within a group, the current session's
 * entry always wins; otherwise the lower-latency transport does (usb over
 * tcp over mdns).
 */
export function dedupeDevices(devices: DeviceSummary[], currentSerial: string | null): DeviceSummary[] {
  const groups = new Map<string, DeviceSummary[]>();
  const singles: DeviceSummary[] = [];
  for (const device of devices) {
    if (!device.model || !device.device) {
      singles.push(device);
      continue;
    }
    const key = `${device.model}\u0000${device.device}`;
    const group = groups.get(key);
    if (group) group.push(device);
    else groups.set(key, [device]);
  }

  const result = [...singles];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const current = group.find((d) => d.serial === currentSerial);
    if (current) {
      result.push(current);
      continue;
    }
    const best = [...group].sort((a, b) => TRANSPORT_RANK[a.transport] - TRANSPORT_RANK[b.transport])[0];
    result.push(best);
  }
  return result;
}
