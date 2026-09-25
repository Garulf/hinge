import { expect, test } from "vitest";
import { deviceResultMessage, PAIR_INPUT_MESSAGES, transferToast } from "../../src/renderer/chrome/toast-text";
import type { TransferProgress } from "../../src/shared/wire";

const base: TransferProgress = { id: "t1", name: "My App.apk", kind: "install", state: "queued", bytesWritten: 0, totalBytes: 0 };

test("a transfer keeps one sticky toast while it runs, then a timed one with the result", () => {
  expect(transferToast(base)).toEqual({ id: "transfer-t1", text: "Waiting to send My App.apk", sticky: true });
  expect(transferToast({ ...base, state: "running", bytesWritten: 25, totalBytes: 100 })).toEqual({
    id: "transfer-t1",
    text: "Installing My App.apk 25%",
    progress: 0.25,
    sticky: true,
  });
  expect(transferToast({ ...base, state: "done" })).toEqual({ id: "transfer-t1", text: "Installed My App.apk" });
  expect(transferToast({ ...base, kind: "push", name: "café.jpg", state: "done" })).toEqual({ id: "transfer-t1", text: "Sent café.jpg to Download" });
  expect(transferToast({ ...base, state: "cancelled" }).text).toBe("Cancelled My App.apk");
});

test("a failed transfer is an error toast with the first line of the message", () => {
  expect(transferToast({ ...base, state: "error", message: "Error: INSTALL_FAILED_VERSION_DOWNGRADE\n  at x" })).toEqual({
    id: "transfer-t1",
    text: "Could not install My App.apk: INSTALL_FAILED_VERSION_DOWNGRADE",
    tone: "error",
  });
});

test("device results read as their outcome", () => {
  expect(deviceResultMessage({ type: "list", devices: [] })).toBeNull();
  expect(deviceResultMessage({ type: "pair", ok: true, connectedAddress: "192.168.1.5:40000" })).toEqual({ text: "Paired and connected to 192.168.1.5:40000", tone: "info" });
  expect(deviceResultMessage({ type: "pair", ok: true, connectedAddress: null })?.text).toMatch(/connect port/);
  expect(deviceResultMessage({ type: "pair", ok: false, connectedAddress: null, message: "Error: wrong code" })).toEqual({ text: "Pairing failed: wrong code", tone: "error" });
  expect(deviceResultMessage({ type: "connect", ok: false, message: "Error: refused" })).toEqual({ text: "Could not connect: refused", tone: "error" });
  expect(deviceResultMessage({ type: "switch-to-wifi", ok: true, address: "10.0.0.2:5555" })?.text).toBe("Switched to Wi-Fi at 10.0.0.2:5555");
  expect(deviceResultMessage({ type: "disconnect", ok: false, message: "nope" })?.tone).toBe("error");
});

test("a pairing that worked but whose connect failed keeps the reason and asks for the port", () => {
  expect(deviceResultMessage({ type: "pair", ok: true, connectedAddress: null, message: "Error: connection refused\n  at x" })).toEqual({
    text: "Paired, but connecting failed: connection refused. Enter the connect port shown on the phone.",
    tone: "error",
  });
});

test("bad pairing input has its own messages", () => {
  expect(PAIR_INPUT_MESSAGES.code).toEqual({ text: "The pairing code is the 6 digits shown on the phone", tone: "error" });
  expect(PAIR_INPUT_MESSAGES.hostPort.text).toMatch(/IP address and port/);
  expect(PAIR_INPUT_MESSAGES.connectPort.text).toMatch(/port/);
});
