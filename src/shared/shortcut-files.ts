const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

export interface PixelSize {
  width: number;
  height: number;
}

/** A one-image ICO holding the PNG as it is, which Windows Vista and later read. */
export function pngToIco(png: Uint8Array, size: PixelSize): Uint8Array {
  const offset = ICONDIR_BYTES + ICONDIRENTRY_BYTES;
  const ico = new Uint8Array(offset + png.length);
  const view = new DataView(ico.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  view.setUint8(6, icoSide(size.width));
  view.setUint8(7, icoSide(size.height));
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.length, true);
  view.setUint32(18, offset, true);
  ico.set(png, offset);
  return ico;
}

/** An ICONDIRENTRY side is one byte, with 0 meaning 256 px or more. */
function icoSide(px: number): number {
  return px >= 256 ? 0 : px;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;

export function pngSize(png: Uint8Array): PixelSize | null {
  if (png.length < IHDR_HEIGHT_OFFSET + 4 || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(IHDR_WIDTH_OFFSET), height: view.getUint32(IHDR_HEIGHT_OFFSET) };
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

export function desktopEntry(o: { label: string; exec: string; pkg: string; icon: string | null }): string {
  const exec = [o.exec, "--app", o.pkg].map(execArgument).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${stringValue(o.label)}`,
    `Exec=${stringValue(exec)}`,
    ...(o.icon === null ? [] : [`Icon=${stringValue(o.icon)}`]),
    "Terminal=false",
    "Categories=Utility;",
    "StartupWMClass=hinge",
    "",
  ].join("\n");
}

const FORBIDDEN_IN_FILE_NAMES = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Windows keeps these names for devices, whatever the case and whatever extension follows. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\s*(\.|$))/i;

/** The label made safe as a Windows file name, without its extension. */
export function shortcutFileName(label: string, pkg: string): string {
  const name = label.replace(FORBIDDEN_IN_FILE_NAMES, "_").trim().replace(/[. ]+$/, "");
  return name === "" ? pkg : name.replace(WINDOWS_DEVICE_NAME, "$1_");
}

/** The executable a shortcut should start: the portable exe or AppImage the user actually has, not the copy unpacked to a temp folder. */
export function launcherTarget(o: { platform: NodeJS.Platform; execPath: string; env: Record<string, string | undefined> }): string {
  const wrapper = o.platform === "win32" ? o.env.PORTABLE_EXECUTABLE_FILE : o.platform === "linux" ? o.env.APPIMAGE : undefined;
  return wrapper || o.execPath;
}

export const APP_USER_MODEL_ID = "net.garulf.hinge";

export interface TaskbarDetails {
  appId: string;
  relaunchCommand: string;
  relaunchDisplayName: string;
  appIconPath: string;
  appIconIndex: number;
}

/** Windows only offers to pin a window with its own AppUserModelId when the window also says how to start it again. */
export function taskbarDetails(o: { platform: NodeJS.Platform; execPath: string; env: Record<string, string | undefined> }): TaskbarDetails {
  const target = launcherTarget(o);
  return { appId: APP_USER_MODEL_ID, relaunchCommand: `"${target}"`, relaunchDisplayName: "hinge", appIconPath: target, appIconIndex: 0 };
}
