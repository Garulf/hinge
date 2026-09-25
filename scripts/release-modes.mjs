import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PACKAGED_SOURCES = ["build", "vendor", "LICENSE-scrcpy", "THIRD_PARTY_NOTICES.md"];

/** electron-builder copies each file's mode into the deb, and a checkout on some filesystems leaves every file group- and world-writable. */
function dropSharedWrite(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) dropSharedWrite(join(path, entry));
  }
  if (stat.mode & 0o022) chmodSync(path, stat.mode & 0o7755);
}

for (const source of PACKAGED_SOURCES) {
  const path = join(repoRoot, source);
  if (existsSync(path)) dropSharedWrite(path);
}
