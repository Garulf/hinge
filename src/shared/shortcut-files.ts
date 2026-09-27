const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

/** A one-image ICO holding the PNG as it is, which Windows Vista and later read. */
export function pngToIco(png: Uint8Array, size: number): Uint8Array {
  const offset = ICONDIR_BYTES + ICONDIRENTRY_BYTES;
  const ico = new Uint8Array(offset + png.length);
  const view = new DataView(ico.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  const side = size >= 256 ? 0 : size;
  view.setUint8(6, side);
  view.setUint8(7, side);
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.length, true);
  view.setUint32(18, offset, true);
  ico.set(png, offset);
  return ico;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_WIDTH_OFFSET = 16;

export function pngWidth(png: Uint8Array): number | null {
  if (png.length < IHDR_WIDTH_OFFSET + 4 || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
  return new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(IHDR_WIDTH_OFFSET);
}

/** Desktop Entry spec: a string value keeps to one line, and a backslash is itself escaped. */
function stringValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

const EXEC_RESERVED = /[\s"'\\><~|&;$*?#()`]/;

/** Desktop Entry spec: quoting an Exec argument comes before the string escaping, which stringValue applies to the whole line. */
function execArgument(arg: string): string {
  const quoted = arg === "" || EXEC_RESERVED.test(arg) ? `"${arg.replace(/["`$\\]/g, "\\$&")}"` : arg;
  return quoted.replace(/%/g, "%%");
}

export function desktopEntry(o: { label: string; exec: string; pkg: string; icon: string }): string {
  const exec = [o.exec, "--app", o.pkg].map(execArgument).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${stringValue(o.label)}`,
    `Exec=${stringValue(exec)}`,
    `Icon=${stringValue(o.icon)}`,
    "Terminal=false",
    "Categories=Utility;",
    "StartupWMClass=hinge",
    "",
  ].join("\n");
}

const FORBIDDEN_IN_FILE_NAMES = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/** The label made safe as a Windows file name, without its extension. */
export function shortcutFileName(label: string, pkg: string): string {
  const name = label.replace(FORBIDDEN_IN_FILE_NAMES, "_").trim().replace(/[. ]+$/, "");
  return name === "" ? pkg : name;
}

/** The executable a shortcut should start: the portable exe or AppImage the user actually has, not the copy unpacked to a temp folder. */
export function launcherTarget(o: { platform: NodeJS.Platform; execPath: string; env: Record<string, string | undefined> }): string {
  const wrapper = o.platform === "win32" ? o.env.PORTABLE_EXECUTABLE_FILE : o.platform === "linux" ? o.env.APPIMAGE : undefined;
  return wrapper || o.execPath;
}
