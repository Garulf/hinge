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

const MDNS_SERIAL = /^adb-(.+)-[^-.]+\._adb(?:-tls-connect)?\._tcp/;

/** adb names a phone found over mDNS `adb-<serialno>-<suffix>._adb-tls-connect._tcp`. */
export function serialnoFromMdns(serial: string): string | null {
  return MDNS_SERIAL.exec(serial)?.[1] ?? null;
}

export type IdentityOf = (device: DeviceSummary) => string | null;

/**
 * One physical phone, whichever adb transport it is on: the same phone is
 * listed twice over Wi-Fi (ip:port and its mDNS name), and its wireless port
 * changes on every restart. `serialno` is its `getprop ro.serialno`, null
 * when that could not be read.
 */
export function deviceIdentity(device: DeviceSummary, serialno: string | null): string {
  const read = serialno?.trim();
  if (read) return read;
  const fromMdns = serialnoFromMdns(device.serial);
  if (fromMdns) return fromMdns;
  if (device.transport === "usb") return device.serial;
  if (device.model && device.device) return `${device.model}+${device.device}`;
  return device.serial;
}

const TRANSPORT_RANK: Record<TransportKind, number> = { usb: 0, tcp: 1, mdns: 2 };

function byTransport(a: DeviceSummary, b: DeviceSummary): number {
  return TRANSPORT_RANK[a.transport] - TRANSPORT_RANK[b.transport];
}

/**
 * `preferred` is an adb serial (an explicit choice) or a phone's identity
 * (the remembered phone): an exact serial wins, then the transport the
 * session is already on, then the lowest-latency transport of that phone.
 */
export function pickDevice(
  devices: DeviceSummary[],
  preferred: string | null,
  identityOf: IdentityOf = () => null,
  currentSerial: string | null = null,
): DeviceSummary | undefined {
  const candidates = devices.filter(
    (d) => d.state === "device" || d.state === "unauthorized" || d.state === "authorizing",
  );
  if (preferred !== null) {
    const exact = candidates.find((d) => d.serial === preferred);
    if (exact) return exact;
    const same = candidates.filter((d) => identityOf(d) === preferred);
    if (same.length > 0) return same.find((d) => d.serial === currentSerial) ?? [...same].sort(byTransport)[0];
  }
  const usb = candidates.find((d) => d.transport === "usb");
  if (usb) return usb;
  return candidates[0];
}

function modelKey(device: DeviceSummary): string | null {
  return device.model && device.device ? `${device.model}\u0000${device.device}` : null;
}

/**
 * Collapses the same physical phone when it is listed twice (its ip:port
 * transport entry and its mDNS-discovered serial), keyed by its identity,
 * or by model+device while that is not known yet. Devices with neither are
 * left alone rather than risking merging two different phones with unknown
 * metadata. Within a group, the current session's entry always wins;
 * otherwise the lower-latency transport does (usb over tcp over mdns).
 */
export function dedupeDevices(devices: DeviceSummary[], currentSerial: string | null, identityOf: IdentityOf = () => null): DeviceSummary[] {
  const groups = new Map<string, DeviceSummary[]>();
  const singles: DeviceSummary[] = [];
  for (const device of devices) {
    const id = identityOf(device);
    const key = id !== null ? `id\u0000${id}` : modelKey(device);
    if (key === null) {
      singles.push(device);
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(device);
    else groups.set(key, [device]);
  }

  const result = [...singles];
  for (const group of groups.values()) {
    result.push(group.find((d) => d.serial === currentSerial) ?? [...group].sort(byTransport)[0]);
  }
  return result;
}
