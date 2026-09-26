import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { clampModelAngles, MODEL_REST } from "../shared/model-rotation";
import { defaultModifiers, normaliseModifiers } from "../shared/shortcuts";
import type { DeviceSettings, Settings, SettingsPatch } from "../shared/settings";

export type { DeviceSettings, Settings, SettingsPatch, ShortcutModifier } from "../shared/settings";

export const SETTINGS_VERSION = 4;

export function defaultSettings(platform: string = process.platform): Settings {
  return {
    version: 4,
    colourway: "jetblack",
    videoCodec: "h264",
    videoBitRate: 16_000_000,
    maxSize: 0,
    maxFps: 0,
    audio: true,
    shortcutModifiers: defaultModifiers(platform),
    alwaysOnTop: false,
    scrollSmoothing: 150,
    scrollSpeed: 1,
    lastDevice: null,
    view: "work",
    mirrorNotifications: true,
    devices: {},
  };
}

export const DEFAULT_SETTINGS: Settings = defaultSettings();

type PatchKey = keyof SettingsPatch;

const isNonNegative = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isBoolean = (v: unknown): boolean => typeof v === "boolean";
const isPositive = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;
const isView = (v: unknown): boolean => v === "work" || v === "showcase";

const FIELD_CHECKS: Record<PatchKey, (value: unknown) => boolean> = {
  colourway: (v) => typeof v === "string",
  videoCodec: (v) => v === "h264" || v === "h265",
  videoBitRate: isNonNegative,
  maxSize: isNonNegative,
  maxFps: isNonNegative,
  audio: isBoolean,
  shortcutModifiers: Array.isArray,
  alwaysOnTop: isBoolean,
  scrollSmoothing: isNonNegative,
  scrollSpeed: isPositive,
  lastDevice: (v) => v === null || typeof v === "string",
  view: isView,
  mirrorNotifications: isBoolean,
};

export function isSettingKey(key: string): key is PatchKey {
  return Object.hasOwn(FIELD_CHECKS, key);
}

export function validSettingValue(key: PatchKey, value: unknown): boolean {
  return FIELD_CHECKS[key](value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps only the per-phone fields with values of the right type. */
export function sanitiseDeviceSettings(value: unknown): DeviceSettings {
  if (!isPlainObject(value)) return {};
  const { pxPerMm, windowPosition, view, rotation } = value;
  const result: DeviceSettings = {};
  if (view === "work" || view === "showcase") result.view = view;
  if (isPlainObject(rotation) && typeof rotation.yaw === "number" && typeof rotation.pitch === "number") {
    result.rotation = clampModelAngles({ yaw: rotation.yaw, pitch: rotation.pitch });
  }
  if (typeof pxPerMm === "number" && Number.isFinite(pxPerMm) && pxPerMm > 0) result.pxPerMm = pxPerMm;
  if (isPlainObject(windowPosition)) {
    const { x, y } = windowPosition;
    if (Number.isFinite(x) && Number.isFinite(y)) result.windowPosition = { x: x as number, y: y as number };
  }
  return result;
}

function sanitiseDeviceMap(value: unknown): Record<string, DeviceSettings> {
  if (!isPlainObject(value)) return {};
  const result: Record<string, DeviceSettings> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) result[key] = sanitiseDeviceSettings(entry);
  }
  return result;
}

/**
 * Keyed by the version a stored file reports; each function takes that
 * version's shape and returns the next version's, so `migrate` can chain them
 * up to `currentVersion`.
 */
export type MigrationMap = Record<number, (data: Record<string, unknown>) => Record<string, unknown>>;

function sameModifiers(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((v, i) => v === expected[i]);
}

/**
 * 1 to 2: devices were keyed by the adb transport serial, which changes with
 * the wireless port, so they move aside until each serial's identity is
 * known; the long-gone single shortcutModifier key is dropped; and on
 * Windows the old left Alt + left Super default becomes left Alt alone.
 * 2 to 3: every phone gets the model's turn, at rest.
 * 3 to 4: notification mirroring is added, on by default.
 */
export function settingsMigrations(platform: string): MigrationMap {
  return {
    1: (data) => {
      const { shortcutModifier: _stale, devices, ...rest } = data;
      const next: Record<string, unknown> = { ...rest, version: 2, devices: {} };
      if (isPlainObject(devices) && Object.keys(devices).length > 0) next.legacyDevices = devices;
      if (platform === "win32" && sameModifiers(rest.shortcutModifiers, ["lalt", "lsuper"])) next.shortcutModifiers = ["lalt"];
      return next;
    },
    2: (data) => {
      const devices = isPlainObject(data.devices) ? data.devices : {};
      const withRotation = Object.fromEntries(
        Object.entries(devices).map(([id, entry]) => [id, isPlainObject(entry) ? { rotation: { ...MODEL_REST }, ...entry } : entry]),
      );
      return { ...data, version: 3, devices: withRotation };
    },
    3: (data) => ({ ...data, version: 4, mirrorNotifications: true }),
  };
}

function migrate(data: Record<string, unknown>, migrations: MigrationMap, currentVersion: number): Record<string, unknown> {
  let current = data;
  while (typeof current.version === "number" && current.version < currentVersion) {
    const step = migrations[current.version];
    if (!step) break;
    current = step(current);
  }
  return current;
}

/** Each field is checked on its own: a missing or mistyped one takes its default, rather than the whole file being treated as corrupt. */
function withDefaults(data: Record<string, unknown>, defaults: Settings): Settings {
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(FIELD_CHECKS) as PatchKey[]) {
    if (key in data && validSettingValue(key, data[key])) result[key] = data[key];
  }
  result.shortcutModifiers = normaliseModifiers(result.shortcutModifiers, defaults.shortcutModifiers);
  result.devices = sanitiseDeviceMap(data.devices);
  const legacy = sanitiseDeviceMap(data.legacyDevices);
  if (Object.keys(legacy).length > 0) result.legacyDevices = legacy;
  if (typeof data.version === "number") result.version = data.version;
  return result as unknown as Settings;
}

async function moveToBadFile(path: string): Promise<void> {
  try {
    await unlink(`${path}.bad`);
  } catch {
    // no previous .bad file to remove; fine either way
  }
  try {
    await rename(path, `${path}.bad`);
  } catch {
    // the corrupt file could not be preserved (e.g. read-only fs); defaults are used regardless
  }
}

async function readSettingsFile(path: string, migrations: MigrationMap, currentVersion: number, defaults: Settings): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    await moveToBadFile(path);
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await moveToBadFile(path);
    return defaults;
  }
  if (!isPlainObject(parsed) || typeof parsed.version !== "number") {
    await moveToBadFile(path);
    return defaults;
  }

  return withDefaults(migrate(parsed, migrations, currentVersion), defaults);
}

export type RenameFn = (from: string, to: string) => Promise<void>;

const RENAME_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 50;

function isTransientLock(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY";
}

/** On Windows a virus scanner or indexer briefly holding the target makes the rename fail with EPERM or EBUSY. */
async function renameWithRetry(renameFile: RenameFn, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_RETRIES || !isTransientLock(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    }
  }
}

let tmpCounter = 0;

async function atomicWrite(path: string, contents: string, renameFile: RenameFn): Promise<void> {
  tmpCounter += 1;
  const tmpPath = `${path}.tmp.${process.pid}.${tmpCounter}`;
  await writeFile(tmpPath, contents, "utf8");
  try {
    await renameWithRetry(renameFile, tmpPath, path);
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
}

export interface SettingsStore {
  readonly current: Settings;
  save(patch: SettingsPatch): Promise<void>;
  saveDevice(id: string, patch: DeviceSettings): Promise<void>;
  /**
   * The first time an adb serial's identity is known: a version 1 entry
   * saved under that serial joins the identity's own (whose values win), and
   * a lastDevice naming the serial names the identity instead. Writes
   * nothing when there is nothing to move.
   */
  adoptTransport(serial: string, id: string): Promise<void>;
  /** Returns an unsubscribe function. */
  onChange(fn: (settings: Settings) => void): () => void;
}

export async function loadSettings(
  path: string,
  opts?: { migrations?: MigrationMap; currentVersion?: number; platform?: string; rename?: RenameFn },
): Promise<SettingsStore> {
  const platform = opts?.platform ?? process.platform;
  const migrations = opts?.migrations ?? settingsMigrations(platform);
  const currentVersion = opts?.currentVersion ?? SETTINGS_VERSION;
  const renameFile = opts?.rename ?? rename;
  let current = await readSettingsFile(path, migrations, currentVersion, defaultSettings(platform));
  const listeners = new Set<(settings: Settings) => void>();
  // Chained so two overlapping save()/saveDevice() calls never write to the
  // same temp path at once or read a stale `current` at the time they
  // actually run: each mutator only computes its patch once its turn in the
  // queue arrives, against whatever the previous write just committed.
  let queue: Promise<void> = Promise.resolve();

  function notify(): void {
    for (const fn of listeners) fn(current);
  }

  async function persist(next: Settings | null): Promise<void> {
    if (next === null) return;
    current = next;
    await atomicWrite(path, JSON.stringify(current, null, 2), renameFile);
    notify();
  }

  function enqueue(mutate: () => Settings | null): Promise<void> {
    const task = queue.then(() => persist(mutate()));
    // The chain must survive a failed write so later calls still run in
    // order, but each call's own caller still sees that write's rejection.
    queue = task.catch(() => {});
    return task;
  }

  function adopted(serial: string, id: string): Settings | null {
    const legacy = current.legacyDevices?.[serial];
    const renamesLast = current.lastDevice === serial && serial !== id;
    if (!legacy && !renamesLast) return null;
    const next: Settings = { ...current };
    if (renamesLast) next.lastDevice = id;
    if (legacy) {
      next.devices = { ...current.devices, [id]: { ...legacy, ...current.devices[id] } };
      const { [serial]: _moved, ...rest } = current.legacyDevices ?? {};
      if (Object.keys(rest).length > 0) next.legacyDevices = rest;
      else delete next.legacyDevices;
    }
    return next;
  }

  return {
    get current() {
      return current;
    },
    save(patch) {
      return enqueue(() => ({ ...current, ...patch }));
    },
    saveDevice(id, patch) {
      return enqueue(() => ({
        ...current,
        devices: { ...current.devices, [id]: { ...current.devices[id], ...patch } },
      }));
    },
    adoptTransport(serial, id) {
      return enqueue(() => adopted(serial, id));
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
