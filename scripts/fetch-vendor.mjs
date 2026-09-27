import { createHash } from "node:crypto";
import extract from "extract-zip";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  renameSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = join(repoRoot, "vendor");

export const TARGETS = [
  {
    file: "scrcpy-server-v4.1",
    url: "https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1",
    algo: "sha256",
    sum: "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae",
  },
  {
    file: "platform-tools_r37.0.1-linux.zip",
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip",
    algo: "sha1",
    sum: "477254aa5f903c15cf51001717bdf347fb6b53e0",
    extractTo: "platform-tools-linux",
    keep: ["adb", "NOTICE.txt"],
  },
  {
    file: "platform-tools_r37.0.1-win.zip",
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip",
    algo: "sha1",
    sum: "e03e78b1d80b396f1c3358e31251cb31740e1110",
    extractTo: "platform-tools-win",
    keep: ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt"],
  },
];

export function selectTargets(targets, only) {
  if (!only) return targets;
  return targets.filter((t) => !t.extractTo || only.has(t.extractTo.replace("platform-tools-", "")));
}

export function keptFilesFor(target) {
  return target.extractTo ? target.keep : [target.file];
}

function parseOnly(argv) {
  const idx = argv.indexOf("--only");
  if (idx === -1) return null;
  return new Set(argv[idx + 1].split(","));
}

function hashOf(bytes, algo) {
  return createHash(algo).update(bytes).digest("hex");
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function verify(target, bytes) {
  const actual = hashOf(bytes, target.algo);
  if (actual !== target.sum) {
    console.error(`checksum mismatch for ${target.file}`);
    console.error(`  expected: ${target.sum}`);
    console.error(`  actual:   ${actual}`);
    process.exit(1);
  }
}

async function extractZip(target, zipBytes, rootDir) {
  const destDir = join(rootDir, target.extractTo);
  const partialDestDir = `${destDir}.partial`;
  mkdirSync(rootDir, { recursive: true });
  const tempDir = mkdtempSync(join(rootDir, ".tmp-"));

  try {
    const zipPath = join(tempDir, target.file);
    writeFileSync(zipPath, zipBytes);
    const extractedDir = join(tempDir, "extracted");
    await extract(zipPath, { dir: extractedDir });

    const innerDir = join(extractedDir, target.innerDir ?? "platform-tools");
    if (existsSync(partialDestDir)) rmSync(partialDestDir, { recursive: true, force: true });
    mkdirSync(partialDestDir, { recursive: true });
    for (const entry of target.keep) {
      const from = join(innerDir, entry);
      if (!existsSync(from)) throw new Error(`${target.file} did not contain expected entry ${entry}`);
      renameSync(from, join(partialDestDir, entry));
    }

    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    renameSync(partialDestDir, destDir);
  } catch (err) {
    rmSync(partialDestDir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  for (const entry of target.keep) {
    if ([".dll", ".txt", ".jar"].some((ext) => entry.endsWith(ext))) continue;
    chmodSync(join(destDir, entry), 0o755);
  }
}

function isTargetPresent(target, rootDir) {
  if (target.extractTo) {
    const destDir = join(rootDir, target.extractTo);
    return keptFilesFor(target).every((entry) => existsSync(join(destDir, entry)));
  }
  const destPath = join(rootDir, target.file);
  if (!existsSync(destPath)) return false;
  return hashOf(readFileSync(destPath), target.algo) === target.sum;
}

export async function fetchTarget(target, rootDir = vendorDir) {
  if (isTargetPresent(target, rootDir)) {
    console.log(`up to date: ${target.file}`);
    return;
  }

  console.log(`fetching ${target.file}`);
  const bytes = await download(target.url);
  verify(target, bytes);

  if (target.extractTo) {
    await extractZip(target, bytes, rootDir);
  } else {
    mkdirSync(rootDir, { recursive: true });
    const destPath = join(rootDir, target.file);
    writeFileSync(destPath, bytes);
    chmodSync(destPath, 0o755);
  }
  console.log(`ready: ${target.file}`);
}

async function main() {
  const only = parseOnly(process.argv.slice(2));
  mkdirSync(vendorDir, { recursive: true });

  for (const target of selectTargets(TARGETS, only)) {
    await fetchTarget(target);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
