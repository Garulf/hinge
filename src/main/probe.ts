import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptions4_1 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath } from "@yume-chan/scrcpy";
import { PushReadableStream } from "@yume-chan/stream-extra";
import type { AdbHost } from "./adb-host";
import { resolveOutputPath } from "./output-path";
import { startSampler } from "./posture-sampler";
import { pickDevice, transportOf, type DeviceSummary } from "./transport";
import { vendorPaths } from "./vendor-paths";

export interface ProbeReport {
  createdAt: string;
  serial: string;
  model: string | null;
  androidRelease: string;
  sdk: string;
  oneShot: Record<string, string>;
  timeline: { ms: number; lines: string[] }[];
  displays: unknown;
}

const ONE_SHOT = [
  "getprop ro.product.model",
  "getprop ro.build.version.release",
  "getprop ro.build.version.sdk",
  "cmd device_state print-state",
  "cmd device_state print-states",
  "cmd device_state print-states-simple",
  "dumpsys device_state",
  "dumpsys input | grep -i SurfaceOrientation",
  "dumpsys window displays | grep -m1 -E '^ *mRotation='",
  "wm size",
  "wm density",
  "dumpsys display | grep -iE 'mBaseDisplayInfo|uniqueId|type='",
  "dumpsys sensorservice | grep -iE -A3 'hinge|fold'",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DeviceLister {
  getDevices(): Promise<{ serial: string; state: string; model?: string | null }[]>;
}

export async function waitForDevice(
  host: { client: DeviceLister },
  preferredSerial: string | null,
  onProgress: (text: string) => void,
): Promise<DeviceSummary> {
  onProgress("Waiting for a phone...");
  const deadline = Date.now() + 60_000;
  let lastMessage = "waiting";
  for (;;) {
    const devices = await host.client.getDevices();
    const summaries: DeviceSummary[] = devices.map((d) => ({
      serial: d.serial,
      state: d.state,
      model: d.model ?? null,
      device: null,
      transport: transportOf(d.serial),
    }));
    const device = pickDevice(summaries, preferredSerial);
    if (device && device.state === "device") return device;
    if (device && (device.state === "unauthorized" || device.state === "authorizing")) {
      if (lastMessage !== "unauthorized") {
        onProgress("Allow USB debugging on your phone");
        lastMessage = "unauthorized";
      }
    } else if (lastMessage !== "waiting") {
      onProgress("Waiting for a phone...");
      lastMessage = "waiting";
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for a phone");
    await sleep(500);
  }
}

async function runOneShot(adb: Adb, command: string): Promise<string> {
  try {
    const shell = adb.subprocess.shellProtocol;
    if (shell) {
      const result = await shell.spawn(command).wait().toString();
      const text = `${result.stdout}${result.stderr}`.trim();
      return result.exitCode === 0 ? text : `${text}\n[exit ${result.exitCode}]`;
    }
    const text = await adb.subprocess.noneProtocol.spawn(command).wait().toString();
    return text.trim();
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

async function getDisplays(adb: Adb, serverPath: string): Promise<unknown> {
  try {
    const jar = await readFile(serverPath);
    await AdbScrcpyClient.pushServer(
      adb,
      new PushReadableStream<Uint8Array>((controller) => {
        controller.enqueue(new Uint8Array(jar));
        controller.close();
      }),
    );
    return await AdbScrcpyClient.getDisplays(adb, DefaultServerPath, new AdbScrcpyOptions4_1({ videoCodec: "h264", tunnelForward: true }));
  } catch (e) {
    return { error: String(e) };
  }
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, i) => line === b[i]);
}

async function runSampler(
  adb: Adb,
  seconds: number,
  onProgress: (text: string) => void,
): Promise<{ ms: number; lines: string[] }[]> {
  const timeline: { ms: number; lines: string[] }[] = [];
  const start = Date.now();
  let previous: string[] | null = null;
  let latest = "(waiting for a sample)";

  const { stop } = await startSampler(adb, (sample) => {
    latest = sample.lines[0] ?? "(no reading)";
    if (previous === null || !sameLines(previous, sample.lines)) {
      timeline.push({ ms: Date.now() - start, lines: sample.lines });
      previous = sample.lines;
    }
  });

  const endAt = Date.now() + seconds * 1000;
  while (Date.now() < endAt) {
    const secondsLeft = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    onProgress(
      `Now: fold it, half-open it, open it flat, rotate it, fold it again. Seconds left: ${secondsLeft}. Current: ${latest}`,
    );
    await sleep(1000);
  }

  await stop();
  return timeline;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function safeSerial(serial: string): string {
  return serial.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function runProbe(opts: {
  host: AdbHost;
  serial: string | null;
  seconds: number;
  out: string | null;
  onProgress(text: string): void;
}): Promise<string> {
  await opts.host.ensureServer();
  const device = await waitForDevice(opts.host, opts.serial, opts.onProgress);
  const adb = await opts.host.open(device.serial);

  const oneShot: Record<string, string> = {};
  for (const command of ONE_SHOT) {
    opts.onProgress(`Running: ${command}`);
    oneShot[command] = await runOneShot(adb, command);
  }

  opts.onProgress("Checking displays...");
  const paths = vendorPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    platform: process.platform,
  });
  const displays = await getDisplays(adb, paths.scrcpyServer);

  const timeline = await runSampler(adb, opts.seconds, opts.onProgress);

  const report: ProbeReport = {
    createdAt: new Date().toISOString(),
    serial: device.serial,
    model: device.model,
    androidRelease: oneShot["getprop ro.build.version.release"] ?? "",
    sdk: oneShot["getprop ro.build.version.sdk"] ?? "",
    oneShot,
    timeline,
    displays,
  };

  const desktop = app.getPath("desktop");
  const path = opts.out ? resolveOutputPath(opts.out, desktop) : join(desktop, `hinge-probe-${safeSerial(device.serial)}-${timestamp()}.json`);
  try {
    await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  } catch (e) {
    throw new Error(`Could not write the probe report to ${path}: ${String(e)}`);
  }
  return path;
}
