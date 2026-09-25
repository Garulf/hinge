import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen } from "electron";
import { AdbHost } from "./adb-host";
import type { ClipboardHost } from "./clipboard-sync";
import { bindSource, DeviceSource, type SessionFactory } from "./app-controller";
import { parseArgs, reportStartupError } from "./cli";
import { createLogger, type Logger } from "./logger";
import type { MediaSink, MediaSource } from "./media-source";
import { resolveOutputPath } from "./output-path";
import { createQueuedWriter } from "./queued-writer";
import { startFoldMonitor } from "./fold-monitor";
import { runProbe } from "./probe";
import { recordProgressHtml, recordResultHtml } from "./probe-window";
import { teeToRecording } from "./recorder";
import { ReplaySource } from "./replay-source";
import { ScrcpySession } from "./scrcpy-session";
import { toStreamSettings } from "./scrcpy-init";
import { withDryRunTransfers } from "./dry-run-transfers";
import { loadSettings, type SettingsStore } from "./settings";
import { bridgeSettings } from "./settings-bridge";
import { vendorPaths } from "./vendor-paths";
import { createPhoneWindow } from "./window";
import { DevicePlacement } from "./window-position";
import { createWirelessDeps } from "./wireless";

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
    // stream, needlessly stretching shutdown. Re-checked after drain() too,
    // since the stream can fail while drain() is waiting on it.
    if (writer.failed) return;
    await writer.drain();
    if (writer.failed) return;
    await new Promise<void>((resolve) => {
      stream.once("finish", () => resolve());
      stream.once("error", () => resolve());
      stream.end();
    });
  };
}

type RunOptions = Extract<ReturnType<typeof parseArgs>, { mode: "run" }>;

async function buildSource(opts: RunOptions, settings: SettingsStore, log: Logger["log"]): Promise<BuiltSource> {
  if (opts.replay) {
    const replay = await ReplaySource.fromFile(opts.replay, { loop: false });
    return { source: opts.dryRunTransfers ? withDryRunTransfers(replay) : replay, closeRecording: async () => {} };
  }

  const paths = vendorPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    platform: process.platform,
  });
  const host = new AdbHost({ adbPath: paths.adb });
  await host.ensureServer();

  const wireless = createWirelessDeps(host.client);
  const onConnected = (serial: string): void => {
    settings.save({ lastDevice: serial }).catch((e) => log(`failed to save lastDevice: ${String(e)}`));
  };

  const clipboardHost: ClipboardHost = { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) };
  const createSession: SessionFactory = (device, adb) =>
    new ScrcpySession({
      adb,
      serial: device.serial,
      model: device.model,
      serverPath: paths.scrcpyServer,
      settings: toStreamSettings(settings.current),
      log,
      clipboardHost,
    });

  if (!opts.record) {
    const source = new DeviceSource({
      host,
      preferredSerial: opts.serial ?? settings.current.lastDevice,
      log,
      createSession,
      foldMonitor: startFoldMonitor,
      wireless,
      onConnected,
    });
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
    preferredSerial: opts.serial ?? settings.current.lastDevice,
    log,
    createSession,
    recordSink: (sink) => teeToRecording(sink, writer, Date.now, log),
    foldMonitor: startFoldMonitor,
    wireless,
    onConnected,
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

async function runMode(opts: RunOptions): Promise<void> {
  if (opts.userData) app.setPath("userData", opts.userData);
  await app.whenReady();
  const logger = createLogger(join(app.getPath("logs"), "hinge.log"));
  const settingsPath = join(app.getPath("userData"), "settings.json");
  const settings = await loadSettings(settingsPath);
  let placement: DevicePlacement | null = null;
  const { win, port } = createPhoneWindow({ onMoved: () => placement?.moved() });
  bridgeSettings(win, settings, ipcMain, settingsPath);
  placement = new DevicePlacement({
    getContentBounds: () => win.getContentBounds(),
    setContentBounds: (bounds) => win.setContentBounds(bounds),
    workAreaFor: (rect) => screen.getDisplayMatching(rect).workArea,
    saved: (serial) => settings.current.devices[serial]?.windowPosition,
    save: (serial, corner) => {
      settings.saveDevice(serial, { windowPosition: corner }).catch((e) => logger.log(`failed to save the window position: ${String(e)}`));
    },
  });

  let source: MediaSource;
  let closeRecording: () => Promise<void> = async () => {};
  try {
    const built = await buildSource(opts, settings, logger.log);
    source = built.source;
    closeRecording = built.closeRecording;
  } catch (e) {
    logger.log(`buildSource failed: ${String(e)}`);
    source = errorSource(String(e));
  }

  bindSource(source, port, { logPath: logger.path, onStatus: (status) => placement?.status(status) });

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
