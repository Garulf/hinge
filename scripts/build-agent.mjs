import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchTarget } from "./fetch-vendor.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sdkDir = join(repoRoot, "vendor", ".agent-sdk");
const sourceDir = join(repoRoot, "agent", "src");
const classesDir = join(repoRoot, "agent", "build", "classes");
const outputJar = join(repoRoot, "vendor", "hinge-agent.jar");

export const TARGETS = [
  {
    file: "build-tools_r35_linux.zip",
    url: "https://dl.google.com/android/repository/build-tools_r35_linux.zip",
    algo: "sha1",
    sum: "2cfaa0bbb2336e9ec18ed3ecea84fa2e2af607bc",
    extractTo: "build-tools-35.0.0",
    innerDir: "android-15/lib",
    keep: ["d8.jar"],
  },
  {
    file: "platform-36_r02.zip",
    url: "https://dl.google.com/android/repository/platform-36_r02.zip",
    algo: "sha1",
    sum: "2c1a80dd4d9f7d0e6dd336ec603d9b5c55a6f576",
    extractTo: "platform-36",
    innerDir: "android-36",
    keep: ["android.jar"],
  },
];

export function javacArgs({ androidJar, classesDir, sources }) {
  return ["--release", "11", "-cp", androidJar, "-d", classesDir, ...sources];
}

export function d8Args({ d8Jar, androidJar, outputJar, classFiles }) {
  return [
    "-cp",
    d8Jar,
    "com.android.tools.r8.D8",
    "--release",
    "--min-api",
    "30",
    "--lib",
    androidJar,
    "--output",
    outputJar,
    ...classFiles,
  ];
}

function filesUnder(dir, extension) {
  return readdirSync(dir, { recursive: true })
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => join(dir, entry))
    .sort();
}

function keptPath(target) {
  return join(sdkDir, target.extractTo, target.keep[0]);
}

function requireTool(tool) {
  const probe = spawnSync(tool, ["-version"], { stdio: "ignore" });
  if (probe.error) {
    throw new Error(`${tool} not found on PATH: building hinge-agent needs a JDK (11 or newer)`);
  }
}

function run(tool, args) {
  const result = spawnSync(tool, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${tool} exited with status ${result.status}`);
}

async function main() {
  requireTool("javac");
  requireTool("java");

  for (const target of TARGETS) {
    await fetchTarget(target, sdkDir);
  }
  const [d8Jar, androidJar] = TARGETS.map(keptPath);

  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  run("javac", javacArgs({ androidJar, classesDir, sources: filesUnder(sourceDir, ".java") }));

  rmSync(outputJar, { force: true });
  run("java", d8Args({ d8Jar, androidJar, outputJar, classFiles: filesUnder(classesDir, ".class") }));
  console.log(`ready: ${outputJar}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
