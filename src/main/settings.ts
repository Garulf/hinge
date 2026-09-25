import { readFile, rename, unlink, writeFile } from "node:fs/promises";

export type ShortcutModifier = "lalt" | "ralt" | "lsuper" | "rsuper" | "lctrl" | "rctrl";

export interface DeviceSettings {
  windowPosition?: { x: number; y: number };
  pxPerMm?: number;
}

export interface Settings {
  version: 1;
  colourway: string;
  videoCodec: "h264" | "h265";
  videoBitRate: number;
  maxSize: number;
  maxFps: number;
  audio: boolean;
  shortcutModifier: ShortcutModifier;
  alwaysOnTop: boolean;
  lastDevice: string | null;
  view: "work" | "showcase";
  devices: Record<string, DeviceSettings>;
}

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  colourway: "Jetblack",
  videoCodec: "h264",
  videoBitRate: 16_000_000,
  maxSize: 0,
  maxFps: 0,
  audio: true,
  shortcutModifier: "lalt",
  alwaysOnTop: false,
  lastDevice: null,
  view: "work",
  devices: {},
};

/**
 * Keyed by the version a stored file reports; each function takes that
 * version's shape and returns the next version's, so `migrate` can chain them
 * up to `currentVersion`. Empty until a real M6+ migration is needed.
 */
export type MigrationMap = Record<number, (data: Record<string, unknown>) => Record<string, unknown>>;

const NO_MIGRATIONS: MigrationMap = {};

export interface SettingsStore {
  readonly current: Settings;
  save(patch: Partial<Omit<Settings, "devices">>): Promise<void>;
  saveDevice(serial: string, patch: DeviceSettings): Promise<void>;
  /** Returns an unsubscribe function. */
  onChange(fn: (settings: Settings) => void): () => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Fills in any field missing from a parsed (and possibly migrated) file with the typed default, rather than treating an incomplete-but-valid file as corrupt. */
function mergeWithDefaults(data: Record<string, unknown>): Settings {
  const devices = isPlainObject(data.devices) ? (data.devices as Settings["devices"]) : {};
  return { ...DEFAULT_SETTINGS, ...data, devices } as Settings;
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

async function readSettingsFile(
  path: string,
  migrations: MigrationMap,
  currentVersion: number,
): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    await moveToBadFile(path);
    return DEFAULT_SETTINGS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await moveToBadFile(path);
    return DEFAULT_SETTINGS;
  }
  if (!isPlainObject(parsed) || typeof parsed.version !== "number") {
    await moveToBadFile(path);
    return DEFAULT_SETTINGS;
  }

  const migrated = migrate(parsed, migrations, currentVersion);
  return mergeWithDefaults(migrated);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, contents, "utf8");
  await rename(tmpPath, path);
}

export async function loadSettings(
  path: string,
  opts?: { migrations?: MigrationMap; currentVersion?: number },
): Promise<SettingsStore> {
  const migrations = opts?.migrations ?? NO_MIGRATIONS;
  const currentVersion = opts?.currentVersion ?? SETTINGS_VERSION;
  let current = await readSettingsFile(path, migrations, currentVersion);
  const listeners = new Set<(settings: Settings) => void>();

  function notify(): void {
    for (const fn of listeners) fn(current);
  }

  async function persist(next: Settings): Promise<void> {
    current = next;
    await atomicWrite(path, JSON.stringify(current, null, 2));
    notify();
  }

  return {
    get current() {
      return current;
    },
    async save(patch) {
      await persist({ ...current, ...patch });
    },
    async saveDevice(serial, patch) {
      await persist({
        ...current,
        devices: { ...current.devices, [serial]: { ...current.devices[serial], ...patch } },
      });
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
