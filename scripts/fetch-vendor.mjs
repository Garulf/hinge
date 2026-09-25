import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, renameSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = join(repoRoot, "vendor");

const TARGETS = [
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
  },
  {
    file: "platform-tools_r37.0.1-win.zip",
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip",
    algo: "sha1",
    sum: "e03e78b1d80b396f1c3358e31251cb31740e1110",
    extractTo: "platform-tools-win",
  },
];

const PLATFORM_TOOLS_KEEP = new Set(["adb", "adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt"]);

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

function extractZip(target, zipBytes) {
  const destDir = join(vendorDir, target.extractTo);
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });

  mkdirSync(vendorDir, { recursive: true });
  const tempDir = mkdtempSync(join(vendorDir, ".tmp-"));
  const zipPath = join(tempDir, target.file);
  writeFileSync(zipPath, zipBytes);
  execFileSync("unzip", ["-q", zipPath, "-d", tempDir]);

  const innerDir = join(tempDir, "platform-tools");
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(innerDir)) {
    if (PLATFORM_TOOLS_KEEP.has(entry)) renameSync(join(innerDir, entry), join(destDir, entry));
  }
  rmSync(tempDir, { recursive: true, force: true });
}

function alreadyPresent(target) {
  if (target.extractTo) {
    const destDir = join(vendorDir, target.extractTo);
    const binName = target.extractTo === "platform-tools-win" ? "adb.exe" : "adb";
    return existsSync(join(destDir, binName));
  }
  const destPath = join(vendorDir, target.file);
  if (!existsSync(destPath)) return false;
  return hashOf(readFileSync(destPath), target.algo) === target.sum;
}

async function fetchTarget(target) {
  if (alreadyPresent(target)) {
    console.log(`up to date: ${target.file}`);
    return;
  }

  console.log(`fetching ${target.file}`);
  const bytes = await download(target.url);
  verify(target, bytes);

  if (target.extractTo) {
    extractZip(target, bytes);
  } else {
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(join(vendorDir, target.file), bytes);
    execFileSync("chmod", ["+x", join(vendorDir, target.file)]);
  }
  console.log(`ready: ${target.file}`);
}

async function main() {
  const only = parseOnly(process.argv.slice(2));
  mkdirSync(vendorDir, { recursive: true });

  const targets = only
    ? TARGETS.filter((t) => !t.extractTo || only.has(t.extractTo.replace("platform-tools-", "")))
    : TARGETS;

  for (const target of targets) {
    await fetchTarget(target);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
