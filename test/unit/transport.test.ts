import { expect, test } from "vitest";
import { deviceStatus, pickDevice, transportOf } from "../../src/main/transport";

test("transport from serial shape", () => {
  expect(transportOf("R5CX1234ABC")).toBe("usb");
  expect(transportOf("192.168.1.40:5555")).toBe("tcp");
  expect(transportOf("[fe80::1]:5555")).toBe("tcp");
  expect(transportOf("adb-R5CX1234ABC-AbCdEf._adb-tls-connect._tcp")).toBe("mdns");
});

test("unauthorized and offline devices produce a status, ready devices do not", () => {
  const d = (state: string) => ({ serial: "S", state, model: null, transport: "usb" as const });
  expect(deviceStatus(undefined)).toEqual({ state: "no-device" });
  expect(deviceStatus(d("unauthorized"))).toEqual({ state: "unauthorized", serial: "S" });
  expect(deviceStatus(d("authorizing"))).toEqual({ state: "unauthorized", serial: "S" });
  expect(deviceStatus(d("offline"))).toEqual({ state: "connecting", serial: "S" });
  expect(deviceStatus(d("device"))).toBeNull();
});

test("prefers the remembered serial, then USB, then anything", () => {
  const usb = { serial: "U", state: "device", model: null, transport: "usb" as const };
  const tcp = { serial: "1.2.3.4:5555", state: "device", model: null, transport: "tcp" as const };
  expect(pickDevice([tcp, usb], "1.2.3.4:5555")).toBe(tcp);
  expect(pickDevice([tcp, usb], null)).toBe(usb);
  expect(pickDevice([tcp], "gone")).toBe(tcp);
  expect(pickDevice([], null)).toBeUndefined();
});
