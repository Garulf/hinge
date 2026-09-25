import { dirname, join } from "node:path";

/** A bare file name (no directory part, "." or "") lands on the desktop; anything with a directory is used as given. */
export function resolveOutputPath(pathArg: string, desktopDir: string): string {
  const dir = dirname(pathArg);
  if (dir === "." || dir === "") return join(desktopDir, pathArg);
  return pathArg;
}
