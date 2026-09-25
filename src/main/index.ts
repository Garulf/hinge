import { createWriteStream } from "node:fs";
import { app, BrowserWindow } from "electron";
import { AdbHost } from "./adb-host";
import { bindSource, DeviceSource } from "./app-controller";
import { parseArgs } from "./cli";
import type { MediaSink, MediaSource } from "./media-source";
import { startSampler } from "./posture-sampler";
import { runProbe } from "./probe";
import { recordProgressHtml, recordResultHtml } from "./probe-window";
import { teeToRecording } from "./recorder";
import { ReplaySource } from "./replay-source";
import { ScrcpySession } from "./scrcpy-session";
import { DEFAULT_STREAM_SETTINGS } from "./scrcpy-init";
import { vendorPaths } from "./vendor-paths";
import { createPhoneWindow, portLikeOf } from "./window";

const mode = parseArgs(process.argv);

function errorSource(message: string): MediaSource {
  return {
    start: async (sink: MediaSink) => sink.status({ state: "error", message }),
    control: () => {},
    stop: async () => {},
  };
}

interface BuiltSource {
  source: MediaSource;
  closeRecording: () => void;
}

async function buildSource(opts: { serial: string | null; replay: string | null; record: string | null }): Promise<BuiltSource> {
  if (opts.replay) return { source: await ReplaySource.fromFile(opts.replay, { loop: false }), closeRecording: () => {} };

  const paths = vendorPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    platform: process.platform,
  });
  const host = new AdbHost({ adbPath: paths.adb });
  await host.ensureServer();

  let recordStream: ReturnType<typeof createWriteStream> | null = null;
  const recordSink = opts.record
    ? (sink: MediaSink) => {
        recordStream = createWriteStream(opts.record as string);
        return teeToRecording(sink, (chunk) => recordStream?.write(chunk), Date.now);
      }
    : undefined;

  const source = new DeviceSource({
    host,
    preferredSerial: opts.serial,
    createSession: (device, adb) =>
      new ScrcpySession({
        adb,
        serial: device.serial,
        model: device.model,
        serverPath: paths.scrcpyServer,
        settings: DEFAULT_STREAM_SETTINGS,
      }),
    recordSink,
    posture: startSampler,
  });

  return { source, closeRecording: () => recordStream?.end() };
}

async function runMode(opts: { serial: string | null; replay: string | null; record: string | null }): Promise<void> {
  await app.whenReady();
  const { win, port } = createPhoneWindow();

  let source: MediaSource;
  let closeRecording = () => {};
  try {
    const built = await buildSource(opts);
    source = built.source;
    closeRecording = built.closeRecording;
  } catch (e) {
    source = errorSource(String(e));
  }

  bindSource(source, portLikeOf(port));
  win.on("closed", () => {
    void source.stop().then(closeRecording);
  });
}

async function probeMode(opts: { serial: string | null; seconds: number; out: string | null }): Promise<void> {
  await app.whenReady();

  const paths = vendorPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    platform: process.platform,
  });
  const host = new AdbHost({ adbPath: paths.adb });

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    frame: true,
    resizable: false,
    title: "hinge probe",
  });

  const setProgress = (text: string): void => {
    void win.webContents.executeJavaScript(
      `document.getElementById('t').textContent = ${JSON.stringify(text)}`,
    );
  };

  await win.loadURL(`data:text/html,${encodeURIComponent(recordProgressHtml())}`);
  setProgress("Starting...");

  try {
    const path = await runProbe({
      host,
      serial: opts.serial,
      seconds: opts.seconds,
      out: opts.out,
      onProgress: setProgress,
    });
    await win.loadURL(`data:text/html,${encodeURIComponent(recordResultHtml(path))}`);
  } catch (e) {
    setProgress(`Failed: ${String(e)}`);
  }
}

if (mode.mode === "run") {
  void runMode(mode);
} else {
  void probeMode(mode);
}

app.on("window-all-closed", () => app.quit());
