import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu } from "electron";
import { AdbHost } from "./adb-host";
import { bindSource, DeviceSource, type SessionFactory } from "./app-controller";
import { parseArgs, reportStartupError } from "./cli";
import { createLogger, type Logger } from "./logger";
import type { MediaSink, MediaSource } from "./media-source";
import { resolveOutputPath } from "./output-path";
import { createQueuedWriter } from "./queued-writer";
import { startSampler } from "./posture-sampler";
import { runProbe } from "./probe";
import { recordProgressHtml, recordResultHtml } from "./probe-window";
import { teeToRecording } from "./recorder";
import { ReplaySource } from "./replay-source";
import { ScrcpySession } from "./scrcpy-session";
import { DEFAULT_STREAM_SETTINGS } from "./scrcpy-init";
import { vendorPaths } from "./vendor-paths";
import { createPhoneWindow } from "./window";

function reportAndExit(e: unknown): never {
  const report = reportStartupError(e, { packaged: app.isPackaged, platform: process.platform });
  if (report.channel === "dialog") dialog.showErrorBox("hinge", report.message);
  else console.error(report.message);
  process.exit(1);
}

let mode: ReturnType<typeof parseArgs>;
try {
  mode = parseArgs(process.argv);
} catch (e) {
  reportAndExit(e);
}

function errorSource(message: string): MediaSource {
  return {
    start: async (sink: MediaSink) => sink.status({ state: "error", message }),
    control: () => {},
    stop: async () => {},
  };
}

interface BuiltSource {
  source: MediaSource;
  closeRecording: () => Promise<void>;
}

/** Opens the write stream up front so a bad path or a permission error surfaces before mirroring starts, instead of crashing mid-session. */
function openRecordStream(path: string): Promise<{ stream: WriteStream } | { error: string }> {
  return new Promise((resolve) => {
    const stream = createWriteStream(path);
    const onError = (e: Error) => {
      stream.off("open", onOpen);
      resolve({ error: String(e) });
    };
    const onOpen = () => {
      stream.off("error", onError);
      resolve({ stream });
    };
    stream.once("error", onError);
    stream.once("open", onOpen);
  });
}

function closeRecordStream(stream: WriteStream, writer: ReturnType<typeof createQueuedWriter>): () => Promise<void> {
  return async () => {
    // A stream that already failed cannot be waited on further: drain()
    // resolves immediately and end() would just wait on an already-dead
    // stream, needlessly stretching shutdown.
    if (writer.failed) return;
    await writer.drain();
    await new Promise<void>((resolve) => {
      stream.once("finish", () => resolve());
      stream.once("error", () => resolve());
      stream.end();
    });
  };
}

async function buildSource(opts: { serial: string | null; replay: string | null; record: string | null }, log: Logger["log"]): Promise<BuiltSource> {
  if (opts.replay) return { source: await ReplaySource.fromFile(opts.replay, { loop: false }), closeRecording: async () => {} };

  const paths = vendorPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    platform: process.platform,
  });
  const host = new AdbHost({ adbPath: paths.adb });
  await host.ensureServer();

  const createSession: SessionFactory = (device, adb) =>
    new ScrcpySession({
      adb,
      serial: device.serial,
      model: device.model,
      serverPath: paths.scrcpyServer,
      settings: DEFAULT_STREAM_SETTINGS,
      log,
    });

  if (!opts.record) {
    const source = new DeviceSource({ host, preferredSerial: opts.serial, log, createSession, posture: startSampler });
    return { source, closeRecording: async () => {} };
  }

  const path = resolveOutputPath(opts.record, app.getPath("desktop"));
  const opened = await openRecordStream(path);
  if ("error" in opened) {
    // Refuse to mirror at all: starting a "record" session that silently
    // is not recording would let the user believe they captured something
    // they did not.
    const message = `Could not open the recording file ${path}: ${opened.error}`;
    log(message);
    return { source: errorSource(message), closeRecording: async () => {} };
  }

  const writer = createQueuedWriter(opened.stream);
  const source = new DeviceSource({
    host,
    preferredSerial: opts.serial,
    log,
    createSession,
    recordSink: (sink) => teeToRecording(sink, writer, Date.now, log),
    posture: startSampler,
  });
  return { source, closeRecording: closeRecordStream(opened.stream, writer) };
}

/** Waits for source.stop() and the recording stream to finish, but never blocks quitting for more than a few seconds. */
function shutdown(source: MediaSource, closeRecording: () => Promise<void>): Promise<void> {
  return Promise.race([
    (async () => {
      await source.stop().catch(() => {});
      await closeRecording();
    })(),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}

async function runMode(opts: { serial: string | null; replay: string | null; record: string | null }): Promise<void> {
  await app.whenReady();
  const logger = createLogger(join(app.getPath("logs"), "hinge.log"));
  const { win, port } = createPhoneWindow();

  let source: MediaSource;
  let closeRecording: () => Promise<void> = async () => {};
  try {
    const built = await buildSource(opts, logger.log);
    source = built.source;
    closeRecording = built.closeRecording;
  } catch (e) {
    logger.log(`buildSource failed: ${String(e)}`);
    source = errorSource(String(e));
  }

  bindSource(source, port, { logPath: logger.path });

  let shuttingDown: Promise<void> | null = null;
  win.on("closed", () => {
    shuttingDown = shutdown(source, closeRecording).then(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (!shuttingDown) app.quit();
  });
}

async function probeMode(opts: { serial: string | null; seconds: number; out: string | null }): Promise<void> {
  await app.whenReady();
  const logger = createLogger(join(app.getPath("logs"), "hinge.log"));

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
    logger.log(text);
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
    await win.loadURL(`data:text/html,${encodeURIComponent(recordResultHtml(path, logger.path))}`);
  } catch (e) {
    logger.log(String(e));
    setProgress(`Failed: ${String(e)} (log: ${logger.path})`);
  }
  app.on("window-all-closed", () => app.quit());
}

Menu.setApplicationMenu(null);

if (mode.mode === "run") {
  void runMode(mode);
} else {
  void probeMode(mode);
}
