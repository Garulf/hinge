import { expect, test } from "vitest";
import { dedupeDevices, deviceIdentity, deviceStatus, pickDevice, serialnoFromMdns, transportOf, type DeviceSummary } from "../../src/main/transport";

test("transport from serial shape", () => {
  expect(transportOf("R5CX1234ABC")).toBe("usb");
  expect(transportOf("192.168.1.40:5555")).toBe("tcp");
  expect(transportOf("[fe80::1]:5555")).toBe("tcp");
  expect(transportOf("adb-R5CX1234ABC-AbCdEf._adb-tls-connect._tcp")).toBe("mdns");
});

test("unauthorized and offline devices produce a status, ready devices do not", () => {
  const d = (state: string) => ({ serial: "S", state, model: null, device: null, transport: "usb" as const });
  expect(deviceStatus(undefined)).toEqual({ state: "no-device" });
  expect(deviceStatus(d("unauthorized"))).toEqual({ state: "unauthorized", serial: "S" });
  expect(deviceStatus(d("authorizing"))).toEqual({ state: "unauthorized", serial: "S" });
  expect(deviceStatus(d("offline"))).toEqual({ state: "connecting", serial: "S" });
  expect(deviceStatus(d("device"))).toBeNull();
});

test("prefers the remembered serial, then USB, then anything", () => {
  const usb = { serial: "U", state: "device", model: null, device: null, transport: "usb" as const };
  const tcp = { serial: "1.2.3.4:5555", state: "device", model: null, device: null, transport: "tcp" as const };
  expect(pickDevice([tcp, usb], "1.2.3.4:5555")).toBe(tcp);
  expect(pickDevice([tcp, usb], null)).toBe(usb);
  expect(pickDevice([tcp], "gone")).toBe(tcp);
  expect(pickDevice([], null)).toBeUndefined();
});

test("dedupeDevices collapses the same phone's ip:port and mDNS entries by model+device, preferring the current session's entry", () => {
  const tcp = { serial: "10.0.0.23:34065", state: "device", model: "Pixel 8", device: "shiba", transport: "tcp" as const };
  const mdns = { serial: "adb-R3-abc._adb-tls-connect._tcp", state: "device", model: "Pixel 8", device: "shiba", transport: "mdns" as const };

  expect(dedupeDevices([tcp, mdns], null)).toEqual([tcp]); // no current session: transport preference (tcp over mdns) wins
  expect(dedupeDevices([tcp, mdns], mdns.serial)).toEqual([mdns]); // the current session's entry is kept even though it is not the preferred transport
});

test("dedupeDevices never merges devices missing model or device metadata, and leaves genuinely different devices alone", () => {
  const tcp = { serial: "10.0.0.23:34065", state: "device", model: "Pixel 8", device: "shiba", transport: "tcp" as const };
  const unknownA = { serial: "unknown-1", state: "device", model: null, device: null, transport: "usb" as const };
  const unknownB = { serial: "unknown-2", state: "device", model: null, device: null, transport: "usb" as const };
  const otherUsb = { serial: "USB1", state: "device", model: "Fold 7", device: "q6q", transport: "usb" as const };

  const result = dedupeDevices([tcp, unknownA, unknownB, otherUsb], null);
  expect(result).toEqual([unknownA, unknownB, tcp, otherUsb]);
});

function summary(serial: string, over: Partial<DeviceSummary> = {}): DeviceSummary {
  return { serial, state: "device", model: "SM-F966B", device: "q7q", transport: transportOf(serial), ...over };
}

test("the serial number inside an mDNS service name", () => {
  expect(serialnoFromMdns("adb-R5CY1234ABC-AbCdEf._adb-tls-connect._tcp")).toBe("R5CY1234ABC");
  expect(serialnoFromMdns("adb-R5CY1234ABC-AbCdEf._adb._tcp")).toBe("R5CY1234ABC");
  expect(serialnoFromMdns("10.0.0.5:5555")).toBeNull();
  expect(serialnoFromMdns("R5CY1234ABC")).toBeNull();
});

test("a phone's identity is its ro.serialno, then the serial in its mDNS name, then its USB serial, then model+device, then the adb serial", () => {
  expect(deviceIdentity(summary("10.0.0.5:41234"), "R5CY1234ABC\n")).toBe("R5CY1234ABC");
  expect(deviceIdentity(summary("adb-R5CY1234ABC-AbCdEf._adb-tls-connect._tcp"), null)).toBe("R5CY1234ABC");
  expect(deviceIdentity(summary("adb-R5CY1234ABC-AbCdEf._adb-tls-connect._tcp"), "  ")).toBe("R5CY1234ABC");
  expect(deviceIdentity(summary("R5CY1234ABC"), null)).toBe("R5CY1234ABC");
  expect(deviceIdentity(summary("10.0.0.5:41234"), null)).toBe("SM-F966B+q7q");
  expect(deviceIdentity(summary("10.0.0.5:41234", { model: null }), null)).toBe("10.0.0.5:41234");
});

test("pickDevice prefers the exact remembered serial, then any transport of the remembered identity", () => {
  const usbOther = summary("OTHERUSB", { model: "Pixel", device: "shiba" });
  const tcp = summary("10.0.0.5:41234");
  const mdns = summary("adb-R5CY-x._adb-tls-connect._tcp");
  const ids: Record<string, string> = { OTHERUSB: "OTHERUSB", "10.0.0.5:41234": "R5CY", "adb-R5CY-x._adb-tls-connect._tcp": "R5CY" };
  const idOf = (d: DeviceSummary) => ids[d.serial] ?? null;

  expect(pickDevice([usbOther, mdns], "R5CY", idOf)).toBe(mdns);
  expect(pickDevice([usbOther, mdns, tcp], "R5CY", idOf)).toBe(tcp);
  expect(pickDevice([usbOther, mdns, tcp], "adb-R5CY-x._adb-tls-connect._tcp", idOf)).toBe(mdns);
  expect(pickDevice([usbOther, mdns, tcp], "R5CY", idOf, mdns.serial)).toBe(mdns);
  expect(pickDevice([usbOther, mdns], "GONE", idOf)).toBe(usbOther);
});

test("dedupeDevices groups by identity when one is known", () => {
  const tcp = summary("10.0.0.5:41234", { model: null, device: null });
  const mdns = summary("adb-R5CY-x._adb-tls-connect._tcp", { model: null, device: null });
  const idOf = () => "R5CY";
  expect(dedupeDevices([tcp, mdns], null, idOf)).toEqual([tcp]);
});
