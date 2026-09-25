import { expect, test } from "vitest";
import { deviceResultToast, transferToast } from "../../src/renderer/chrome/toast-text";
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

test("device results toast their outcome", () => {
  expect(deviceResultToast({ type: "list", devices: [] })).toBeNull();
  expect(deviceResultToast({ type: "pair", ok: true, connectedAddress: "192.168.1.5:40000" })?.text).toBe("Paired and connected to 192.168.1.5:40000");
  expect(deviceResultToast({ type: "pair", ok: true, connectedAddress: null })?.text).toMatch(/connect port/);
  expect(deviceResultToast({ type: "pair", ok: false, connectedAddress: null, message: "Error: wrong code" })).toEqual({ text: "Pairing failed: wrong code", tone: "error" });
  expect(deviceResultToast({ type: "switch-to-wifi", ok: true, address: "10.0.0.2:5555" })?.text).toBe("Switched to Wi-Fi at 10.0.0.2:5555");
  expect(deviceResultToast({ type: "disconnect", ok: false, message: "nope" })?.tone).toBe("error");
});
