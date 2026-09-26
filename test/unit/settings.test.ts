import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_SETTINGS, defaultSettings, loadSettings, settingsMigrations } from "../../src/main/settings";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hinge-settings-"));
  path = join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a missing settings file loads the typed defaults without writing anything", async () => {
  const store = await loadSettings(path);
  expect(store.current).toEqual(DEFAULT_SETTINGS);
  expect(existsSync(path)).toBe(false);
});

test("save() persists a patch atomically and it survives a reload", async () => {
  const store = await loadSettings(path);
  await store.save({ colourway: "Silver", videoCodec: "h265", audio: false });
  expect(store.current).toMatchObject({ colourway: "Silver", videoCodec: "h265", audio: false });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ colourway: "Silver", videoCodec: "h265" });
  // no leftover temp file of any kind from the atomic write
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

  const reloaded = await loadSettings(path);
  expect(reloaded.current).toMatchObject({ colourway: "Silver", videoCodec: "h265", audio: false });
});

test("per-device settings are stored under the device's serial and merged, not replaced, on the next call", async () => {
  const store = await loadSettings(path);
  await store.saveDevice("SERIAL1", { pxPerMm: 11.8 });
  await store.saveDevice("SERIAL1", { windowPosition: { x: 10, y: 20 } });
  expect(store.current.devices.SERIAL1).toEqual({ pxPerMm: 11.8, windowPosition: { x: 10, y: 20 } });

  await store.saveDevice("SERIAL2", { pxPerMm: 9 });
  expect(Object.keys(store.current.devices).sort()).toEqual(["SERIAL1", "SERIAL2"]);
});

test("an unreadable JSON file falls back to defaults and preserves the broken file as .bad", async () => {
  writeFileSync(path, "{not valid json");
  const store = await loadSettings(path);
  expect(store.current).toEqual(DEFAULT_SETTINGS);
  expect(existsSync(`${path}.bad`)).toBe(true);
  expect(readFileSync(`${path}.bad`, "utf8")).toBe("{not valid json");
  expect(existsSync(path)).toBe(false);
});

test("a partial or truncated settings file (as a crash mid-write would leave) falls back to defaults, never crashes", async () => {
  writeFileSync(path, '{"version":1,"colourway":"Silver","videoCo');
  const store = await loadSettings(path);
  expect(store.current).toEqual(DEFAULT_SETTINGS);
  expect(existsSync(`${path}.bad`)).toBe(true);
});

test("a valid object missing newer fields is filled in with defaults rather than treated as corrupt", async () => {
  writeFileSync(path, JSON.stringify({ version: 1, colourway: "Silver" }));
  const store = await loadSettings(path);
  expect(store.current).toEqual({ ...DEFAULT_SETTINGS, colourway: "Silver" });
  expect(existsSync(`${path}.bad`)).toBe(false);
});

test("a repeated .bad from a previous corruption is overwritten, not left stale", async () => {
  writeFileSync(`${path}.bad`, "stale-old-corruption");
  writeFileSync(path, "{also not json");
  const store = await loadSettings(path);
  expect(store.current).toEqual(DEFAULT_SETTINGS);
  expect(readFileSync(`${path}.bad`, "utf8")).toBe("{also not json");
});

test("the migration hook runs on a settings file from an older version before it is used", async () => {
  writeFileSync(path, JSON.stringify({ version: 1, colourway: "Silver" }));
  const store = await loadSettings(path, {
    migrations: {
      1: (data) => ({ ...(data as object), version: 2, colourway: `${String(data.colourway)}-migrated` }),
    },
    currentVersion: 2,
  });
  expect(store.current.colourway).toBe("Silver-migrated");
  expect(store.current.version).toBe(2);
});

test("two overlapping save() calls are serialised: neither is lost to the other reading a stale current", async () => {
  const store = await loadSettings(path);
  await Promise.all([store.save({ colourway: "Silver" }), store.save({ videoCodec: "h265" })]);

  expect(store.current).toMatchObject({ colourway: "Silver", videoCodec: "h265" });
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk).toMatchObject({ colourway: "Silver", videoCodec: "h265" });
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("overlapping save() and saveDevice() calls interleaved many times all land, none silently dropped", async () => {
  const store = await loadSettings(path);
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    writes.push(store.saveDevice(`S${i}`, { pxPerMm: i }));
  }
  await Promise.all(writes);

  for (let i = 0; i < 20; i++) {
    expect(store.current.devices[`S${i}`]).toEqual({ pxPerMm: i });
  }
  const reloaded = await loadSettings(path);
  expect(Object.keys(reloaded.current.devices)).toHaveLength(20);
});

test("onChange fires with the new settings after save() and saveDevice(), not before", async () => {
  const store = await loadSettings(path);
  const seen: unknown[] = [];
  const off = store.onChange((s) => seen.push(s));
  await store.save({ audio: false });
  await store.saveDevice("S1", { pxPerMm: 5 });
  expect(seen).toHaveLength(2);
  expect((seen[0] as { audio: boolean }).audio).toBe(false);
  off();
  await store.save({ audio: true });
  expect(seen).toHaveLength(2);
});

test("the default MOD is left Alt alone on Windows and left Alt + left Super elsewhere", async () => {
  expect(defaultSettings("win32").shortcutModifiers).toEqual(["lalt"]);
  expect(defaultSettings("linux").shortcutModifiers).toEqual(["lalt", "lsuper"]);
  const store = await loadSettings(path, { platform: "win32" });
  expect(store.current.shortcutModifiers).toEqual(["lalt"]);
});

test("each field of a loaded file is checked on its own: a wrong type falls back to that field's default, the rest are kept", async () => {
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      colourway: 7,
      videoCodec: "vp9",
      videoBitRate: "fast",
      maxSize: -5,
      maxFps: 60,
      audio: "yes",
      shortcutModifiers: ["rctrl", "bogus"],
      alwaysOnTop: true,
      lastDevice: 12,
      view: "showcase",
      devices: { A: { pxPerMm: 5, windowPosition: { x: "1", y: 2 }, view: "sideways" }, B: "junk" },
      stray: 1,
    }),
  );
  const store = await loadSettings(path);
  expect(store.current).toEqual({
    ...DEFAULT_SETTINGS,
    maxFps: 60,
    shortcutModifiers: ["rctrl"],
    alwaysOnTop: true,
    view: "showcase",
    devices: { A: { pxPerMm: 5, rotation: { yaw: 0, pitch: 0 } } },
  });
  expect(existsSync(`${path}.bad`)).toBe(false);
});

test("a version 1 file migrates: the stale shortcutModifier key goes, and serial-keyed devices wait to be adopted by identity", async () => {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      colourway: "Silver",
      shortcutModifier: "lalt",
      shortcutModifiers: ["lalt", "lsuper"],
      lastDevice: "10.0.0.5:41234",
      devices: { "10.0.0.5:41234": { pxPerMm: 6, view: "showcase" } },
    }),
  );
  const store = await loadSettings(path, { platform: "linux" });
  expect(store.current.version).toBe(3);
  expect(store.current).not.toHaveProperty("shortcutModifier");
  expect(store.current.shortcutModifiers).toEqual(["lalt", "lsuper"]);
  expect(store.current.devices).toEqual({});
  expect(store.current.legacyDevices).toEqual({ "10.0.0.5:41234": { pxPerMm: 6, view: "showcase" } });
  expect(store.current.lastDevice).toBe("10.0.0.5:41234");
});

test("on Windows the migration swaps the old default left Alt + left Super for the new left Alt default, but keeps a custom choice", async () => {
  writeFileSync(path, JSON.stringify({ version: 1, shortcutModifiers: ["lalt", "lsuper"] }));
  expect((await loadSettings(path, { platform: "win32" })).current.shortcutModifiers).toEqual(["lalt"]);
  writeFileSync(path, JSON.stringify({ version: 1, shortcutModifiers: ["rctrl"] }));
  expect((await loadSettings(path, { platform: "win32" })).current.shortcutModifiers).toEqual(["rctrl"]);
});

test("adoptTransport moves a serial-keyed entry and a serial lastDevice over to the phone's identity, once", async () => {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      lastDevice: "10.0.0.5:41234",
      devices: { "10.0.0.5:41234": { pxPerMm: 6, view: "showcase" }, "adb-R5CY-x._adb-tls-connect._tcp": { windowPosition: { x: 1, y: 2 } }, OTHER: { pxPerMm: 3 } },
    }),
  );
  const store = await loadSettings(path);
  const seen: unknown[] = [];
  store.onChange((s) => seen.push(s));

  await store.adoptTransport("10.0.0.5:41234", "R5CY");
  expect(store.current.devices).toEqual({ R5CY: { pxPerMm: 6, view: "showcase" } });
  expect(store.current.lastDevice).toBe("R5CY");
  expect(store.current.legacyDevices).toEqual({ "adb-R5CY-x._adb-tls-connect._tcp": { windowPosition: { x: 1, y: 2 } }, OTHER: { pxPerMm: 3 } });

  await store.adoptTransport("adb-R5CY-x._adb-tls-connect._tcp", "R5CY");
  expect(store.current.devices).toEqual({ R5CY: { pxPerMm: 6, view: "showcase", windowPosition: { x: 1, y: 2 } } });
  expect(store.current.legacyDevices).toEqual({ OTHER: { pxPerMm: 3 } });

  await store.adoptTransport("OTHER", "OTHER");
  expect(store.current.devices.OTHER).toEqual({ pxPerMm: 3 });
  expect(store.current).not.toHaveProperty("legacyDevices");
  expect(seen).toHaveLength(3);

  await store.adoptTransport("10.0.0.5:41234", "R5CY");
  expect(seen).toHaveLength(3);
  expect(JSON.parse(readFileSync(path, "utf8")).devices.R5CY).toEqual({ pxPerMm: 6, view: "showcase", windowPosition: { x: 1, y: 2 } });
});

test("the identity's own saved values win over an adopted serial-keyed entry", async () => {
  writeFileSync(path, JSON.stringify({ version: 2, devices: { R5CY: { pxPerMm: 9 } }, legacyDevices: { "10.0.0.5:5555": { pxPerMm: 6, view: "showcase" } } }));
  const store = await loadSettings(path);
  await store.adoptTransport("10.0.0.5:5555", "R5CY");
  expect(store.current.devices.R5CY).toEqual({ pxPerMm: 9, view: "showcase", rotation: { yaw: 0, pitch: 0 } });
});

test("a version 2 file migrates to 3: every phone gets the model's turn at rest", async () => {
  writeFileSync(path, JSON.stringify({ version: 2, devices: { R5CY: { pxPerMm: 9, view: "showcase" }, OTHER: {} } }));
  const store = await loadSettings(path);
  expect(store.current.version).toBe(3);
  expect(store.current.devices).toEqual({
    R5CY: { pxPerMm: 9, view: "showcase", rotation: { yaw: 0, pitch: 0 } },
    OTHER: { rotation: { yaw: 0, pitch: 0 } },
  });
});

test("the 2 to 3 migration keeps a turn a phone already has, and running it again changes nothing", async () => {
  const step = settingsMigrations("linux")[2];
  const v2 = { version: 2, devices: { A: { pxPerMm: 5, rotation: { yaw: 10, pitch: -5 } }, B: { view: "work" } } };
  const once = step(v2);
  expect(once).toEqual({ version: 3, devices: { A: { pxPerMm: 5, rotation: { yaw: 10, pitch: -5 } }, B: { view: "work", rotation: { yaw: 0, pitch: 0 } } } });
  expect(step({ ...once, version: 2 })).toEqual(once);

  writeFileSync(path, JSON.stringify(v2));
  const store = await loadSettings(path);
  expect(store.current.devices.A.rotation).toEqual({ yaw: 10, pitch: -5 });
  await store.saveDevice("B", { pxPerMm: 7 });
  expect((await loadSettings(path)).current.devices).toEqual(store.current.devices);
});

test("a saved turn round-trips; one out of range is clamped and a malformed one dropped", async () => {
  const store = await loadSettings(path);
  await store.saveDevice("R5CY", { rotation: { yaw: 30, pitch: -12.5 } });
  expect((await loadSettings(path)).current.devices.R5CY).toEqual({ rotation: { yaw: 30, pitch: -12.5 } });

  writeFileSync(
    path,
    JSON.stringify({ version: 3, devices: { A: { rotation: { yaw: 400, pitch: -90 } }, B: { rotation: { yaw: "1", pitch: 0 } }, C: { rotation: 5 } } }),
  );
  expect((await loadSettings(path)).current.devices).toEqual({ A: { rotation: { yaw: 75, pitch: -60 } }, B: {}, C: {} });
});

test("a rename that fails with EPERM or EBUSY (a virus scanner holding the file on Windows) is retried up to 3 times", async () => {
  let calls = 0;
  const flaky = async (from: string, to: string) => {
    calls++;
    if (calls <= 3) throw Object.assign(new Error("busy"), { code: calls === 2 ? "EBUSY" : "EPERM" });
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  };
  const store = await loadSettings(path, { rename: flaky });
  await store.save({ colourway: "Silver" });
  expect(calls).toBe(4);
  expect(JSON.parse(readFileSync(path, "utf8")).colourway).toBe("Silver");
});

test("a rename that keeps failing gives up after 3 retries, rejects, and leaves no temp file behind", async () => {
  let calls = 0;
  const store = await loadSettings(path, {
    rename: async () => {
      calls++;
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
  });
  await expect(store.save({ colourway: "Silver" })).rejects.toThrow("locked");
  expect(calls).toBe(4);
  expect(readdirSync(dir)).toEqual([]);
});

test("any other rename error is not retried", async () => {
  let calls = 0;
  const store = await loadSettings(path, {
    rename: async () => {
      calls++;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
  });
  await expect(store.save({ colourway: "Silver" })).rejects.toThrow("gone");
  expect(calls).toBe(1);
});
