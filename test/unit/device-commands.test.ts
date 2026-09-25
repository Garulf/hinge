import { afterEach, expect, test, vi } from "vitest";
import { connectAddress, DeviceCommands, validHostPort, validPairingCode } from "../../src/renderer/chrome/device-commands";
import type { RendererToMain } from "../../src/shared/wire";

afterEach(() => vi.useRealTimers());

test("a request resolves with the result carrying its id, others are ignored", async () => {
  const sent: RendererToMain[] = [];
  const commands = new DeviceCommands((msg) => sent.push(msg));
  const first = commands.request({ type: "list" });
  const second = commands.request({ type: "disconnect", serial: "10.0.0.2:5555" });
  expect(sent.map((m) => m.kind === "device-command" && m.id)).toEqual(["cmd-1", "cmd-2"]);
  commands.result("cmd-2", { type: "disconnect", ok: true });
  commands.result("cmd-9", { type: "list", devices: [] });
  commands.result("cmd-1", { type: "list", devices: [] });
  await expect(first).resolves.toEqual({ type: "list", devices: [] });
  await expect(second).resolves.toEqual({ type: "disconnect", ok: true });
});

test("an unanswered request times out", async () => {
  vi.useFakeTimers();
  const commands = new DeviceCommands(() => {});
  const pending = commands.request({ type: "list" }, 1000);
  vi.advanceTimersByTime(1000);
  await expect(pending).rejects.toThrow(/no answer/);
});

test("pairing input validation", () => {
  expect(validPairingCode("123456")).toBe(true);
  expect(validPairingCode(" 123456 ")).toBe(true);
  expect(validPairingCode("12345")).toBe(false);
  expect(validPairingCode("12a456")).toBe(false);
  expect(validHostPort("192.168.1.20:37099")).toBe(true);
  expect(validHostPort("192.168.1.20")).toBe(false);
  expect(validHostPort("192.168.1.20:70000")).toBe(false);
  expect(connectAddress("192.168.1.20:37099", "41234")).toBe("192.168.1.20:41234");
  expect(connectAddress("192.168.1.20:37099", "")).toBeNull();
});
