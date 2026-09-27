import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDesktopShortcut, type DesktopShortcutDeps, type ShortcutLinkOptions } from "../../src/main/desktop-shortcut";
import type { AppIdentity } from "../../src/main/popout-manager";

const APP_PNG = new Uint8Array([7, 7, 7]);
const HINGE_PNG = new Uint8Array([9, 9]);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(o: { platform: NodeJS.Platform; identity?: AppIdentity; env?: Record<string, string | undefined>; linkResult?: boolean; fallback?: Uint8Array }) {
  const root = mkdtempSync(join(tmpdir(), "hinge-shortcut-"));
  dirs.push(root);
  const links: [string, "create", ShortcutLinkOptions][] = [];
  const identified: string[] = [];
  const logs: string[] = [];
  const existing = new Map<string, ShortcutLinkOptions>();
  const deps: DesktopShortcutDeps = {
    platform: o.platform,
    execPath: "/opt/hinge/hinge",
    env: o.env ?? {},
    userData: join(root, "userData"),
    appData: join(root, "AppData", "Roaming"),
    home: join(root, "home"),
    identify: async (pkg) => {
      identified.push(pkg);
      return o.identity ?? { label: "Chat", icon: APP_PNG };
    },
    fallbackIcon: async () => o.fallback ?? HINGE_PNG,
    writeShortcutLink: (path, operation, options) => {
      links.push([path, operation, options]);
      if (o.linkResult ?? true) existing.set(path, options);
      return o.linkResult ?? true;
    },
    readShortcutLink: (path) => existing.get(path) ?? null,
    log: (line) => logs.push(line),
  };
  return { root, deps, links, identified, logs };
}

test("on Linux the app's icon and a desktop entry that opens it are written under the home folder", async () => {
  const { root, deps, identified } = harness({ platform: "linux", env: { APPIMAGE: "/home/a b/Hinge.AppImage" } });

  expect(await createDesktopShortcut(deps, "com.example.chat")).toBe("Shortcut created for Chat");
  expect(identified).toEqual(["com.example.chat"]);
  const icon = join(root, "userData", "shortcut-icons", "com.example.chat.png");
  expect([...readFileSync(icon)]).toEqual([7, 7, 7]);
  const entryPath = join(root, "home", ".local", "share", "applications", "hinge-com.example.chat.desktop");
  const entry = readFileSync(entryPath, "utf8");
  expect(entry).toContain(`\nExec="/home/a b/Hinge.AppImage" --app com.example.chat\n`);
  expect(entry).toContain(`\nIcon=${icon}\n`);
  expect(entry).toContain("\nName=Chat\n");
  expect(statSync(entryPath).mode & 0o777).toBe(0o644);
});

test("on Linux XDG_DATA_HOME, when set, holds the desktop entry", async () => {
  const { root, deps } = harness({ platform: "linux" });
  deps.env = { XDG_DATA_HOME: join(root, "data") };
  await createDesktopShortcut(deps, "com.example.chat");
  expect(readFileSync(join(root, "data", "applications", "hinge-com.example.chat.desktop"), "utf8")).toContain("\nExec=/opt/hinge/hinge --app com.example.chat\n");
});

test("on Windows an ICO is written and a Start menu link opens the app from the portable exe", async () => {
  const { root, deps, links } = harness({ platform: "win32", identity: { label: "a:b/c?", icon: APP_PNG }, env: { PORTABLE_EXECUTABLE_FILE: "D:\\hinge.exe" } });

  expect(await createDesktopShortcut(deps, "com.example.chat")).toBe("Shortcut created for a:b/c?");
  const ico = join(root, "userData", "shortcut-icons", "com.example.chat.ico");
  expect([...readFileSync(ico)]).toEqual([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0, 3, 0, 0, 0, 22, 0, 0, 0, 7, 7, 7]);
  expect(links).toEqual([
    [
      join(root, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "a_b_c_.lnk"),
      "create",
      { target: "D:\\hinge.exe", args: "--app com.example.chat", icon: ico, iconIndex: 0, description: "a:b/c?", appUserModelId: "net.garulf.hinge" },
    ],
  ]);
});

test("an app without an icon gets hinge's own", async () => {
  const { root, deps } = harness({ platform: "linux", identity: { label: "Chat", icon: null } });
  await createDesktopShortcut(deps, "com.example.chat");
  expect([...readFileSync(join(root, "userData", "shortcut-icons", "com.example.chat.png"))]).toEqual([9, 9]);
});

test("a failure is answered with its reason, and a package name that is not one writes nothing", async () => {
  const refused = harness({ platform: "win32", linkResult: false });
  expect(await createDesktopShortcut(refused.deps, "com.example.chat")).toBe("Could not create a shortcut for Chat: Windows did not write the shortcut");

  const mac = harness({ platform: "darwin" });
  expect(await createDesktopShortcut(mac.deps, "com.example.chat")).toBe("Could not create a shortcut for Chat: shortcuts are made on Windows and Linux only");

  const bad = harness({ platform: "linux" });
  expect(await createDesktopShortcut(bad.deps, "../../evil")).toBe("Could not create a shortcut: ../../evil is not an app package name");
  expect(bad.identified).toEqual([]);
});

function programs(root: string, name: string): string {
  return join(root, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", name);
}

test("two apps with the same label get their own Start menu links, and making one again replaces its own", async () => {
  const { root, deps, links } = harness({ platform: "win32", identity: { label: "Chat", icon: APP_PNG } });
  await createDesktopShortcut(deps, "com.example.chat");
  await createDesktopShortcut(deps, "com.other.chat");
  await createDesktopShortcut(deps, "com.example.chat");
  await createDesktopShortcut(deps, "com.other.chat");

  expect(links.map(([path, , options]) => [path, options.args])).toEqual([
    [programs(root, "Chat.lnk"), "--app com.example.chat"],
    [programs(root, "Chat (com.other.chat).lnk"), "--app com.other.chat"],
    [programs(root, "Chat.lnk"), "--app com.example.chat"],
    [programs(root, "Chat (com.other.chat).lnk"), "--app com.other.chat"],
  ]);
});

test("when hinge's own icon cannot be read either, the shortcut is made without one and that is logged", async () => {
  const linux = harness({ platform: "linux", identity: { label: "Chat", icon: null }, fallback: new Uint8Array(0) });
  expect(await createDesktopShortcut(linux.deps, "com.example.chat")).toBe("Shortcut created for Chat");
  expect(existsSync(join(linux.root, "userData", "shortcut-icons", "com.example.chat.png"))).toBe(false);
  expect(readFileSync(join(linux.root, "home", ".local", "share", "applications", "hinge-com.example.chat.desktop"), "utf8")).not.toContain("Icon=");
  expect(linux.logs.some((l) => l.includes("no icon"))).toBe(true);

  const windows = harness({ platform: "win32", identity: { label: "Chat", icon: new Uint8Array(0) }, fallback: new Uint8Array(0) });
  expect(await createDesktopShortcut(windows.deps, "com.example.chat")).toBe("Shortcut created for Chat");
  expect(existsSync(join(windows.root, "userData", "shortcut-icons", "com.example.chat.ico"))).toBe(false);
  expect(windows.links[0][2]).not.toHaveProperty("icon");
  expect(windows.links[0][2]).not.toHaveProperty("iconIndex");
});
