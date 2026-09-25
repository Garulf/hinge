import { join } from "node:path";

/** build/icon.png, packaged into the app archive next to out/, so every build's window carries the hinge icon. */
export function appIconPath(mainDir: string = import.meta.dirname): string {
  return join(mainDir, "../../build/icon.png");
}
