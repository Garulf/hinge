import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopEntry, isPackageName, launcherTarget, pngToIco, pngWidth, shortcutFileName } from "../shared/shortcut-files";
import type { AppIdentity } from "./popout-manager";

/** The part of Electron's ShortcutDetails that hinge sets. */
export interface ShortcutLinkOptions {
  target: string;
  args: string;
  icon: string;
  iconIndex: number;
  description: string;
  appUserModelId: string;
}

export interface DesktopShortcutDeps {
  platform: NodeJS.Platform;
  execPath: string;
  env: Record<string, string | undefined>;
  userData: string;
  /** %APPDATA% on Windows. */
  appData: string;
  home: string;
  identify(pkg: string): Promise<AppIdentity>;
  /** hinge's own icon as a PNG, for an app whose icon is unknown. */
  fallbackIcon(): Promise<Uint8Array>;
  writeShortcutLink(path: string, operation: "create", options: ShortcutLinkOptions): boolean;
}

const APP_USER_MODEL_ID = "net.garulf.hinge";
const DESKTOP_ENTRY_MODE = 0o644;
const DEFAULT_ICON_PX = 256;

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function writeIcon(deps: DesktopShortcutDeps, fileName: string, bytes: Uint8Array): Promise<string> {
  const dir = join(deps.userData, "shortcut-icons");
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, bytes);
  return path;
}

async function writeWindowsLink(deps: DesktopShortcutDeps, pkg: string, label: string, png: Uint8Array): Promise<void> {
  const icon = await writeIcon(deps, `${pkg}.ico`, pngToIco(png, pngWidth(png) ?? DEFAULT_ICON_PX));
  const programs = join(deps.appData, "Microsoft", "Windows", "Start Menu", "Programs");
  await mkdir(programs, { recursive: true });
  const written = deps.writeShortcutLink(join(programs, `${shortcutFileName(label, pkg)}.lnk`), "create", {
    target: launcherTarget(deps),
    args: `--app ${pkg}`,
    icon,
    iconIndex: 0,
    description: label,
    appUserModelId: APP_USER_MODEL_ID,
  });
  if (!written) throw new Error("Windows did not write the shortcut");
}

async function writeLinuxEntry(deps: DesktopShortcutDeps, pkg: string, label: string, png: Uint8Array): Promise<void> {
  const icon = await writeIcon(deps, `${pkg}.png`, png);
  const applications = join(deps.env.XDG_DATA_HOME || join(deps.home, ".local", "share"), "applications");
  await mkdir(applications, { recursive: true });
  const entry = join(applications, `hinge-${pkg}.desktop`);
  await writeFile(entry, desktopEntry({ label, exec: launcherTarget(deps), pkg, icon }), { mode: DESKTOP_ENTRY_MODE });
  await chmod(entry, DESKTOP_ENTRY_MODE);
}

/** Writes a Start menu link or a desktop entry that opens the app in its own window; answers with the notice to show. */
export async function createDesktopShortcut(deps: DesktopShortcutDeps, pkg: string): Promise<string> {
  if (!isPackageName(pkg)) return `Could not create a shortcut: ${pkg} is not an app package name`;
  let label = pkg;
  try {
    const identity = await deps.identify(pkg);
    label = identity.label;
    const png = identity.icon ?? (await deps.fallbackIcon());
    if (deps.platform === "win32") await writeWindowsLink(deps, pkg, label, png);
    else if (deps.platform === "linux") await writeLinuxEntry(deps, pkg, label, png);
    else throw new Error("shortcuts are made on Windows and Linux only");
    return `Shortcut created for ${label}`;
  } catch (e) {
    return `Could not create a shortcut for ${label}: ${reasonOf(e)}`;
  }
}
