import { Menu, Tray } from "electron";
import { appIconPath } from "./app-icon";

export interface TrayActions {
  showPhone(): void;
  openApp(): void;
  quit(): void;
  log?: (line: string) => void;
}

/** hinge's way back to a hidden main window; null where the platform has no tray to offer. */
export function createTray(o: TrayActions): Tray | null {
  try {
    const tray = new Tray(appIconPath());
    tray.setToolTip("hinge");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show phone", click: () => o.showPhone() },
        { label: "Open app…", click: () => o.openApp() },
        { type: "separator" },
        { label: "Quit", click: () => o.quit() },
      ]),
    );
    tray.on("click", () => o.showPhone());
    return tray;
  } catch (e) {
    o.log?.(`no tray icon: ${String(e)}`);
    return null;
  }
}
