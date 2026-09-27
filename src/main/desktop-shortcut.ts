import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPackageName } from "../shared/package-name";
import { desktopEntry, launcherTarget, pngSize, pngToIco, shortcutFileName } from "../shared/shortcut-files";
import { reasonOf } from "./error-text";
import type { AppIdentity } from "./popout-manager";

/** The part of Electron's ShortcutDetails that hinge sets. */
export interface ShortcutLinkOptions {
  target: string;
  args: string;
  icon?: string;
  iconIndex?: number;
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
  /** hinge's own icon as a PNG, for an app whose icon is unknown; empty when it cannot be read. */
  fallbackIcon(): Promise<Uint8Array>;
  writeShortcutLink(path: string, operation: "create", options: ShortcutLinkOptions): boolean;
  /** null when there is no link at the path. */
  readShortcutLink(path: string): { args?: string } | null;
  log(line: string): void;
}

const APP_USER_MODEL_ID = "net.garulf.hinge";
const DESKTOP_ENTRY_MODE = 0o644;
const DEFAULT_ICON_SIZE = { width: 256, height: 256 };

async function writeIcon(deps: DesktopShortcutDeps, fileName: string, bytes: Uint8Array): Promise<string> {
  const dir = join(deps.userData, "shortcut-icons");
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, bytes);
  return path;
}

/** The label's link, unless another app's link already has that name. */
function linkPath(deps: DesktopShortcutDeps, programs: string, label: string, args: string, pkg: string): string {
  const name = shortcutFileName(label, pkg);
  const path = join(programs, `${name}.lnk`);
  const existing = deps.readShortcutLink(path);
  return existing === null || existing.args === args ? path : join(programs, `${name} (${pkg}).lnk`);
}

async function writeWindowsLink(deps: DesktopShortcutDeps, pkg: string, label: string, png: Uint8Array | null): Promise<void> {
  const icon = png ? await writeIcon(deps, `${pkg}.ico`, pngToIco(png, pngSize(png) ?? DEFAULT_ICON_SIZE)) : null;
  const programs = join(deps.appData, "Microsoft", "Windows", "Start Menu", "Programs");
  await mkdir(programs, { recursive: true });
  const args = `--app ${pkg}`;
  const written = deps.writeShortcutLink(linkPath(deps, programs, label, args, pkg), "create", {
    target: launcherTarget(deps),
    args,
    ...(icon === null ? {} : { icon, iconIndex: 0 }),
    description: label,
    appUserModelId: APP_USER_MODEL_ID,
  });
  if (!written) throw new Error("Windows did not write the shortcut");
}

async function writeLinuxEntry(deps: DesktopShortcutDeps, pkg: string, label: string, png: Uint8Array | null): Promise<void> {
  const icon = png ? await writeIcon(deps, `${pkg}.png`, png) : null;
  const applications = join(deps.env.XDG_DATA_HOME || join(deps.home, ".local", "share"), "applications");
  await mkdir(applications, { recursive: true });
  const entry = join(applications, `hinge-${pkg}.desktop`);
  await writeFile(entry, desktopEntry({ label, exec: launcherTarget(deps), pkg, icon }), { mode: DESKTOP_ENTRY_MODE });
  await chmod(entry, DESKTOP_ENTRY_MODE);
}

/** The app's icon, else hinge's; null when neither has any bytes. */
async function shortcutIcon(deps: DesktopShortcutDeps, identity: AppIdentity, pkg: string): Promise<Uint8Array | null> {
  if (identity.icon && identity.icon.length > 0) return identity.icon;
  const fallback = await deps.fallbackIcon();
  if (fallback.length > 0) return fallback;
  deps.log(`no icon for the ${pkg} shortcut: neither the app's nor hinge's could be read`);
  return null;
}

/** Writes a Start menu link or a desktop entry that opens the app in its own window; answers with the notice to show. */
export async function createDesktopShortcut(deps: DesktopShortcutDeps, pkg: string): Promise<string> {
  if (!isPackageName(pkg)) return `Could not create a shortcut: ${pkg} is not an app package name`;
  let label = pkg;
  try {
    const identity = await deps.identify(pkg);
    label = identity.label;
    const png = await shortcutIcon(deps, identity, pkg);
    if (deps.platform === "win32") await writeWindowsLink(deps, pkg, label, png);
    else if (deps.platform === "linux") await writeLinuxEntry(deps, pkg, label, png);
    else throw new Error("shortcuts are made on Windows and Linux only");
    return `Shortcut created for ${label}`;
  } catch (e) {
    return `Could not create a shortcut for ${label}: ${reasonOf(e)}`;
  }
}
