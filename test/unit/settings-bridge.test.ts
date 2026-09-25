import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bridgeSettings, sanitiseDevicePatch, sanitisePatch } from "../../src/main/settings-bridge";
import { loadSettings } from "../../src/main/settings";

test("sanitisePatch keeps known keys with values of the right type and drops the rest", () => {
  expect(
    sanitisePatch({
      colourway: "mint",
      alwaysOnTop: true,
      videoCodec: "vp9",
      maxFps: -1,
      videoBitRate: 8_000_000,
      version: 7,
      devices: {},
      bogus: 1,
      lastDevice: null,
      shortcutModifiers: ["rctrl", "nope"],
      view: "showcase",
    }),
  ).toEqual({ colourway: "mint", alwaysOnTop: true, videoBitRate: 8_000_000, lastDevice: null, shortcutModifiers: ["rctrl"], view: "showcase" });
  expect(sanitisePatch(null)).toEqual({});
  expect(sanitisePatch("x")).toEqual({});
});

test("sanitiseDevicePatch keeps a positive pxPerMm and a numeric position only", () => {
  expect(sanitiseDevicePatch({ pxPerMm: 5.5, windowPosition: { x: 1, y: 2 }, other: 1 })).toEqual({ pxPerMm: 5.5, windowPosition: { x: 1, y: 2 } });
  expect(sanitiseDevicePatch({ pxPerMm: 0, windowPosition: { x: "1", y: 2 } })).toEqual({});
});

function fakes() {
  const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>();
  const sent: unknown[] = [];
  const onTop: boolean[] = [];
  const webContents = { send: (_channel: string, value: unknown) => sent.push(value) };
  const win = { webContents, setAlwaysOnTop: (flag: boolean) => onTop.push(flag) };
  const ipc = { handle: (channel: string, fn: (event: { sender: unknown }, ...args: unknown[]) => unknown) => handlers.set(channel, fn) };
  return { handlers, sent, onTop, win, ipc, own: { sender: webContents } };
}

test("the bridge serves, saves, pushes changes back and applies always-on-top", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hinge-bridge-"));
  const store = await loadSettings(join(dir, "settings.json"));
  const { handlers, sent, onTop, win, ipc, own } = fakes();
  bridgeSettings(win, store, ipc, "/x/settings.json");
  expect(onTop).toEqual([false]);

  expect(handlers.get("hinge:settings-get")!(own)).toMatchObject({ colourway: "jetblack" });
  expect(handlers.get("hinge:settings-get")!({ sender: {} })).toBeNull();
  expect(handlers.get("hinge:settings-path")!(own)).toBe("/x/settings.json");

  await handlers.get("hinge:settings-save")!(own, { alwaysOnTop: true, colourway: "mint" });
  expect(onTop).toEqual([false, true]);
  expect(sent.at(-1)).toMatchObject({ alwaysOnTop: true, colourway: "mint" });

  await handlers.get("hinge:settings-save-device")!(own, "R3CX", { pxPerMm: 6 });
  expect(store.current.devices.R3CX).toEqual({ pxPerMm: 6 });
  expect(onTop).toEqual([false, true]);
});
