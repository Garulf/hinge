import { expect, test } from "vitest";
import { isPackageName } from "../../src/shared/package-name";
import { desktopEntry, launcherTarget, pngToIco, pngWidth, shortcutFileName } from "../../src/shared/shortcut-files";

const FAKE_PNG = new Uint8Array([1, 2, 3]);

test("an ICO wraps the PNG in one 32-bit entry at offset 22, with 0 standing for 256 px", () => {
  expect([...pngToIco(FAKE_PNG, 256)]).toEqual([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0, 3, 0, 0, 0, 22, 0, 0, 0, 1, 2, 3]);
  expect([...pngToIco(FAKE_PNG, 48)]).toEqual([0, 0, 1, 0, 1, 0, 48, 48, 0, 0, 1, 0, 32, 0, 3, 0, 0, 0, 22, 0, 0, 0, 1, 2, 3]);
});

test("the ICO's resource size is little-endian over all four bytes", () => {
  const ico = pngToIco(new Uint8Array(0x010203), 96);
  expect([...ico.subarray(14, 18)]).toEqual([0x03, 0x02, 0x01, 0x00]);
  expect(ico.length).toBe(22 + 0x010203);
});

test("a PNG's width comes from its IHDR, and anything else has none", () => {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01, 0x00, 0, 0, 0x01, 0x00];
  expect(pngWidth(new Uint8Array(header))).toBe(256);
  expect(pngWidth(FAKE_PNG)).toBeNull();
});

test("a desktop entry quotes an Exec path with a space and leaves the Name as it is", () => {
  const entry = desktopEntry({
    label: `Tom's "Chat" / Ünïcode 100%`,
    exec: "/home/a b/Hinge.AppImage",
    pkg: "com.example.chat",
    icon: "/home/a b/.config/hinge/shortcut-icons/com.example.chat.png",
  });
  expect(entry).toBe(
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=Tom's "Chat" / Ünïcode 100%`,
      `Exec="/home/a b/Hinge.AppImage" --app com.example.chat`,
      "Icon=/home/a b/.config/hinge/shortcut-icons/com.example.chat.png",
      "Terminal=false",
      "Categories=Utility;",
      "StartupWMClass=hinge",
      "",
    ].join("\n"),
  );
});

test("Exec escapes quote, backtick, dollar and backslash inside quotes, doubles %, then escapes backslashes again as a string value", () => {
  const entry = desktopEntry({ label: "x", exec: "/opt/it's `$x`\\y \"5%\"", pkg: "com.a", icon: "/i.png" });
  expect(entry).toContain('\nExec="/opt/it\'s \\\\`\\\\$x\\\\`\\\\\\\\y \\\\"5%%\\\\"" --app com.a\n');
  expect(desktopEntry({ label: "x", exec: "/opt/hinge/hinge", pkg: "com.a", icon: "/i.png" })).toContain("\nExec=/opt/hinge/hinge --app com.a\n");
  expect(desktopEntry({ label: "x", exec: "/opt/50%/hinge", pkg: "com.a", icon: "/i.png" })).toContain("\nExec=/opt/50%%/hinge --app com.a\n");
});

test("a Name with a backslash or a newline is escaped so it stays one line", () => {
  expect(desktopEntry({ label: "a\\b\nc", exec: "/h", pkg: "com.a", icon: "/i.png" })).toContain("\nName=a\\\\b\\nc\n");
});

test("a shortcut file name loses characters Windows forbids, control characters and trailing dots and spaces, and falls back to the package", () => {
  expect(shortcutFileName("a:b/c?", "com.a")).toBe("a_b_c_");
  expect(shortcutFileName(`<>:"/\\|?*`, "com.a")).toBe("_________");
  expect(shortcutFileName("a\u0001b\u007f", "com.a")).toBe("a_b_");
  expect(shortcutFileName("  Chat. . ", "com.a")).toBe("Chat");
  expect(shortcutFileName("...", "com.example.chat")).toBe("com.example.chat");
  expect(shortcutFileName("   ", "com.example.chat")).toBe("com.example.chat");
  expect(shortcutFileName("Ünïcode Chat", "com.a")).toBe("Ünïcode Chat");
});

test("the launcher is the portable exe on Windows, the AppImage on Linux, else the running executable", () => {
  const execPath = "/usr/lib/hinge/hinge";
  expect(launcherTarget({ platform: "win32", execPath, env: { PORTABLE_EXECUTABLE_FILE: "D:\\hinge.exe" } })).toBe("D:\\hinge.exe");
  expect(launcherTarget({ platform: "win32", execPath, env: {} })).toBe(execPath);
  expect(launcherTarget({ platform: "win32", execPath, env: { APPIMAGE: "/a.AppImage" } })).toBe(execPath);
  expect(launcherTarget({ platform: "linux", execPath, env: { APPIMAGE: "/home/a b/Hinge.AppImage" } })).toBe("/home/a b/Hinge.AppImage");
  expect(launcherTarget({ platform: "linux", execPath, env: {} })).toBe(execPath);
  expect(launcherTarget({ platform: "linux", execPath, env: { PORTABLE_EXECUTABLE_FILE: "D:\\hinge.exe", APPIMAGE: "" } })).toBe(execPath);
});

test("only a real package name is used in a file name", () => {
  for (const pkg of ["com.example.chat", "com.sec.android.app.launcher", "a_b.C9"]) expect(isPackageName(pkg), pkg).toBe(true);
  for (const pkg of ["", "../x", "a/b", "com..x", ".com", "com.", "a b", "a\\b"]) expect(isPackageName(pkg), pkg).toBe(false);
});
