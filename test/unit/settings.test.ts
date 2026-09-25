import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/main/settings";

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
      1: (data) => ({ ...(data as object), version: 2, migrated: true }),
    },
    currentVersion: 2,
  });
  expect((store.current as unknown as { migrated: boolean }).migrated).toBe(true);
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
