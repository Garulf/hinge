import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, screen, type Tray, type WebContents } from "electron";
import type { DisplayGeometry } from "../shared/popout";
import { AdbHost } from "./adb-host";
import type { ClipboardHost } from "./clipboard-sync";
import { bindSource, DeviceSource, type ConnectedPhone, type NotificationMirrorStarter, type SessionFactory } from "./app-controller";
import { appFromArgv, parseArgs, reportStartupError } from "./cli";
import { CompanionOwner, type CompanionLike } from "./companion-owner";
import { CompanionSession } from "./companion-session";
import { afterPopoutClosed, onMainWindowClose } from "./lifecycle";
import { createLogger, type Logger } from "./logger";
import type { MediaSink, MediaSource } from "./media-source";
import { launchAppOnPhone } from "./intents";
import { PopoutManager, type PopoutManagerDeps, type PopoutSessionLike } from "./popout-manager";
import { bindPopoutPort } from "./popout-port";
import { createPopoutWindow } from "./popout-window";
import { resolveOutputPath } from "./output-path";
import { createQueuedWriter } from "./queued-writer";
import { startCallWatcher } from "./call-watcher";
import { startFoldMonitor } from "./fold-monitor";
import { startNotificationMirror, type Notifier } from "./notification-mirror";
import { runProbe } from "./probe";
import { recordProgressHtml, recordResultHtml } from "./probe-window";
import { teeToRecording } from "./recorder";
import { ReplaySource } from "./replay-source";
import { ScrcpySession } from "./scrcpy-session";
import { toStreamSettings } from "./scrcpy-init";
import { createTray } from "./tray";
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
  /** What a pop-out streams from; absent when there is no phone to stream. */
  popoutSession?: PopoutManagerDeps["createSession"];
  companion?: (phone: ConnectedPhone) => CompanionLike;
  setMainVideo?: (on: boolean) => void;
  /** Stands in for a phone in replay mode, so pop-outs open at once. */
  replayPhone?: ConnectedPhone;
}

/** How the source reports its phone to the pop-outs and the companion; both are built after the source, so they are looked up on every call. */
interface PhoneHooks {
  mainVideo: boolean;
  onPhone(phone: ConnectedPhone | null): void;
  clipboardPush(content: string): bigint;
}

const REPLAY_PHONE: ConnectedPhone = { adb: null as never, serial: "replay", deviceId: "replay", model: null };

/** For the e2e test: replays the same recording in a pop-out, and records each display resize in __hingePopoutResizes. */
function replayPopoutSession(file: string): PopoutSessionLike {
  const replay = ReplaySource.fromFile(file, { loop: false });
  const resizes = globalThis as { __hingePopoutResizes?: DisplayGeometry[] };
  return {
    start: async (sink) => (await replay).start(sink),
    control: (intent) => void replay.then((r) => r.control(intent)).catch(() => {}),
    stop: async () => (await replay).stop(),
    resize: (g) => (resizes.__hingePopoutResizes ??= []).push(g),
  };
}

function noPopoutSession(message: string): PopoutSessionLike {
  return { ...errorSource(message), resize: () => {} };
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

function electronNotifier(): Notifier {
  return {
    show({ title, body, persistent }) {
      const notification = new Notification(
        persistent ? { title, body, timeoutType: "never", urgency: "critical" } : { title, body },
      );
      notification.show();
      return { onClick: (cb) => notification.on("click", cb), close: () => notification.close() };
    },
  };
}

async function buildSource(opts: RunOptions, settings: SettingsStore, log: Logger["log"], win: BrowserWindow, hooks: PhoneHooks): Promise<BuiltSource> {
  if (opts.replay) {
    const file = opts.replay;
    const replay = await ReplaySource.fromFile(file, { loop: false });
    return {
      source: opts.dryRunTransfers ? withDryRunTransfers(replay) : replay,
      closeRecording: async () => {},
      popoutSession: () => replayPopoutSession(file),
      replayPhone: REPLAY_PHONE,
    };
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
  const onConnected = (id: string): void => {
    settings.save({ lastDevice: id }).catch((e) => log(`failed to save lastDevice: ${String(e)}`));
  };
  const onIdentified = (serial: string, id: string): Promise<void> => settings.adoptTransport(serial, id);

  const notifier = electronNotifier();
  const notificationMirror: NotificationMirrorStarter = async (adb, mirrorLog) => {
    const shared = {
      enabled: () => settings.current.mirrorNotifications,
      notifier,
      isWindowFocused: () => win.isFocused(),
      focusWindow: () => focusWindow(win),
      log: mirrorLog,
    };
    const stops = await Promise.all([
      startNotificationMirror(adb, { ...shared, launchApp: (pkg) => launchAppOnPhone(adb, pkg, mirrorLog) }),
      startCallWatcher(adb, shared),
    ]);
    return async () => {
      await Promise.all(stops.map((stop) => stop()));
    };
  };

  const clipboardHost: ClipboardHost = { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) };
  const videoSessionOptions = () => ({
    serverPath: paths.scrcpyServer,
    settings: toStreamSettings(settings.current),
    log,
    clipboardHost,
    companion: true,
    clipboardPush: (content: string) => hooks.clipboardPush(content),
  });
  const createSession: SessionFactory = (device, adb, deviceId) =>
    new ScrcpySession({ adb, serial: device.serial, model: device.model, deviceId, ...videoSessionOptions() });
  const phoneSessions = {
    popoutSession: (phone: ConnectedPhone, pkg: string, geometry: DisplayGeometry) =>
      new ScrcpySession({ adb: phone.adb, serial: phone.serial, model: phone.model, deviceId: phone.deviceId, ...videoSessionOptions(), role: { kind: "popout", pkg, geometry } }),
    companion: (phone: ConnectedPhone) =>
      new CompanionSession({ adb: phone.adb, serverPath: paths.scrcpyServer, settings: toStreamSettings(settings.current), clipboardHost, log }),
  };
  const phoneOptions = { mainVideo: hooks.mainVideo, onPhone: (phone: ConnectedPhone | null) => hooks.onPhone(phone) };

  if (!opts.record) {
    const source = new DeviceSource({
      host,
      preferred: opts.serial ?? settings.current.lastDevice,
      log,
      createSession,
      foldMonitor: startFoldMonitor,
      notificationMirror,
      wireless,
      onConnected,
      onIdentified,
      ...phoneOptions,
    });
    return { source, closeRecording: async () => {}, ...phoneSessions, setMainVideo: (on) => source.setMainVideo(on) };
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
    preferred: opts.serial ?? settings.current.lastDevice,
    log,
    createSession,
    recordSink: (sink) => teeToRecording(sink, writer, Date.now, log),
    foldMonitor: startFoldMonitor,
    notificationMirror,
    wireless,
    onConnected,
    onIdentified,
    ...phoneOptions,
  });
  return { source, closeRecording: closeRecordStream(opened.stream, writer), ...phoneSessions, setMainVideo: (on) => source.setMainVideo(on) };
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

/** A second launch hands over to the running window instead of opening another adb session on the same phone. */
function holdSingleInstance(): boolean {
  if (app.requestSingleInstanceLock()) return true;
  app.quit();
  return false;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function electronNotice(): (text: string) => void {
  return (text) => new Notification({ title: "hinge", body: text }).show();
}

async function runMode(opts: RunOptions): Promise<void> {
  if (opts.userData) app.setPath("userData", opts.userData);
  if (!holdSingleInstance()) return;
  await app.whenReady();
  // Toasts on Windows are grouped and actioned by AppUserModelId; without a
  // matching one set explicitly, an installed, portable and unpacked build
  // of the same app each gets their own default id and none of them work.
  if (process.platform === "win32") app.setAppUserModelId("net.garulf.hinge");
  const logger = createLogger(join(app.getPath("logs"), "hinge.log"));
  const settingsPath = join(app.getPath("userData"), "settings.json");
  const settings = await loadSettings(settingsPath);
  let placement: DevicePlacement | null = null;
  let workAreaChanged = (): void => {};
  const { win, port } = createPhoneWindow({
    onMoved: () => {
      placement?.moved();
      workAreaChanged();
    },
    showWhenReady: opts.app === null,
  });
  let secondLaunch = (_argv: string[]): void => focusWindow(win);
  app.on("second-instance", (_event, argv) => secondLaunch(argv));
  workAreaChanged = () => {
    if (!win.isDestroyed()) win.webContents.send("hinge:work-area-changed");
  };
  screen.on("display-metrics-changed", workAreaChanged);
  const popoutContents = new Set<WebContents>();
  bridgeSettings(win, settings, ipcMain, settingsPath, () => popoutContents);
  placement = new DevicePlacement({
    getContentBounds: () => win.getContentBounds(),
    setContentBounds: (bounds) => win.setContentBounds(bounds),
    workAreaFor: (rect) => screen.getDisplayMatching(rect).workArea,
    saved: (id) => settings.current.devices[id]?.windowPosition,
    save: (id, corner) => {
      settings.saveDevice(id, { windowPosition: corner }).catch((e) => logger.log(`failed to save the window position: ${String(e)}`));
    },
    isFullScreen: () => win.isFullScreen(),
    restored: () => workAreaChanged(),
  });
  placement.preApply(settings.current.lastDevice);

  const phoneHooks: PhoneHooks = { mainVideo: opts.app === null, onPhone: () => {}, clipboardPush: () => 0n };
  let built: BuiltSource;
  try {
    built = await buildSource(opts, settings, logger.log, win, phoneHooks);
  } catch (e) {
    logger.log(`buildSource failed: ${String(e)}`);
    built = { source: errorSource(String(e)), closeRecording: async () => {} };
  }
  const { source, closeRecording } = built;
  const setMainVideo = built.setMainVideo ?? (() => {});

  const showNotification = electronNotice();
  const popouts = new PopoutManager({
    createWindow: (o) => {
      const popout = createPopoutWindow(o);
      popoutContents.add(popout.webContents);
      popout.onClosed(() => popoutContents.delete(popout.webContents));
      return popout;
    },
    createSession: built.popoutSession ?? (() => noPopoutSession("No phone to open apps from")),
    bindPort: bindPopoutPort,
    identify: async (_phone, pkg) => ({ label: pkg, icon: null }),
    workArea: () => screen.getDisplayMatching(win.getBounds()).workArea,
    savedBounds: () => null,
    saveBounds: () => {},
    notice: (text) => {
      port.postMessage({ kind: "notice", text }, []);
      if (!win.isDestroyed() && !win.isVisible()) showNotification(text);
    },
    log: logger.log,
  });

  const mainSink = bindSource(source, port, {
    logPath: logger.path,
    onStatus: (status) => placement?.status(status),
    onRendererMessage: (msg) => {
      if (msg.kind === "popout-open") popouts.open(msg.pkg);
    },
  });

  const companion = built.companion ? new CompanionOwner({ create: built.companion, sink: mainSink, log: logger.log }) : null;
  phoneHooks.onPhone = (phone) => {
    popouts.setPhone(phone);
    companion?.phone(phone);
  };
  phoneHooks.clipboardPush = (content) => companion?.beginPush(content) ?? 0n;
  const mainVisible = (): boolean => !win.isDestroyed() && win.isVisible();
  const refreshCompanion = (): void => companion?.wanted(mainVisible() || popouts.count() > 0);
  win.on("show", refreshCompanion);
  win.on("hide", refreshCompanion);

  let shuttingDown: Promise<void> | null = null;
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });
  const quitHinge = (): void => {
    if (shuttingDown) return;
    quitting = true;
    shuttingDown = (async () => {
      await Promise.all([popouts.closeAll(), companion?.stop()]);
      await shutdown(source, closeRecording);
    })().then(() => app.quit());
  };

  const showMain = (): void => {
    focusWindow(win);
    setMainVideo(true);
  };
  const hideMain = (): void => {
    win.hide();
    setMainVideo(false);
  };

  win.on("close", (e) => {
    placement?.flush();
    if (quitting || onMainWindowClose({ popouts: popouts.count() }) === "quit") return;
    e.preventDefault();
    hideMain();
  });
  popouts.onCountChanged((n) => {
    refreshCompanion();
    if (afterPopoutClosed({ mainVisible: mainVisible(), popouts: n }) === "quit") quitHinge();
  });
  secondLaunch = (argv) => {
    const pkg = appFromArgv(argv);
    if (pkg) popouts.open(pkg);
    else showMain();
  };

  let tray: Tray | null = createTray({
    showPhone: showMain,
    openApp: () => {
      showMain();
      port.postMessage({ kind: "open-picker" }, []);
    },
    quit: quitHinge,
    log: logger.log,
  });

  if (built.replayPhone) popouts.setPhone(built.replayPhone);
  if (opts.app) popouts.open(opts.app);

  win.on("closed", () => {
    placement?.closed();
    screen.off("display-metrics-changed", workAreaChanged);
    tray?.destroy();
    tray = null;
    quitHinge();
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
