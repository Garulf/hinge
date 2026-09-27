import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell as electronShell, type Tray, type WebContents } from "electron";
import type { DisplayGeometry } from "../shared/popout";
import { restoreBounds } from "../shared/popout-bounds";
import { AdbHost } from "./adb-host";
import { AppCatalog, answerAppsRequest } from "./app-catalog";
import { appIconPath } from "./app-icon";
import type { ClipboardHost } from "./clipboard-sync";
import { bindSource, DeviceSource, type ConnectedPhone, type NotificationMirrorStarter, type SessionFactory } from "./app-controller";
import { launchRequest, parseArgs, reportStartupError } from "./cli";
import { CompanionOwner, type CompanionLike } from "./companion-owner";
import { CompanionSession } from "./companion-session";
import { dumpActivities, landedOnPhoneScreen, popOutCurrent } from "./current-app";
import { createDesktopShortcut, type DesktopShortcutDeps } from "./desktop-shortcut";
import { AppShell } from "./app-shell";
import { shutdownWithin } from "./lifecycle";
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
import { createPhoneWindow, focusWindow } from "./window";
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
  catalog?: AppCatalog;
}

/** How the source reports its phone to the pop-outs and the companion; both are built after the source, so they are looked up on every call. */
interface PhoneHooks {
  mainVideo: boolean;
  /** A notification or call toast was clicked. */
  showMain(): void;
  onPhone(phone: ConnectedPhone | null): void;
  clipboardPush(content: string): bigint;
}

const REPLAY_PHONE: ConnectedPhone = { adb: null as never, serial: "replay", deviceId: "replay", model: null };

/** For the e2e test: replays the same recording in a pop-out, as the app's own frames, and records each display resize in __hingePopoutResizes. */
function replayPopoutSession(file: string): PopoutSessionLike {
  const replay = ReplaySource.fromFile(file, { loop: false });
  const resizes = globalThis as { __hingePopoutResizes?: DisplayGeometry[] };
  const appStarted: (() => void)[] = [];
  return {
    start: async (sink) => {
      const source = await replay;
      for (const cb of appStarted) cb();
      await source.start(sink);
    },
    onAppStarted: (cb) => void appStarted.push(cb),
    control: (intent) => void replay.then((r) => r.control(intent)).catch(() => {}),
    stop: async () => (await replay).stop(),
    resize: (g) => (resizes.__hingePopoutResizes ??= []).push(g),
  };
}

function noPopoutSession(message: string): PopoutSessionLike {
  return { ...errorSource(message), resize: () => {}, onAppStarted: () => {} };
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
  const catalog = new AppCatalog({ agentPath: paths.agent, cacheDir: join(app.getPath("userData"), "app-icons"), log });

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
      focusWindow: () => hooks.showMain(),
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
    return { source, closeRecording: async () => {}, ...phoneSessions, catalog, setMainVideo: (on) => source.setMainVideo(on) };
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
  return { source, closeRecording: closeRecordStream(opened.stream, writer), ...phoneSessions, catalog, setMainVideo: (on) => source.setMainVideo(on) };
}

const SHUTDOWN_LIMIT_MS = 5000;

/**
 * A second launch hands over to the running window instead of opening
 * another adb session on the same phone. The app it asks for travels as the
 * lock's data, since its argv can arrive reordered.
 */
function holdSingleInstance(requested: string | null): boolean {
  if (app.requestSingleInstanceLock({ app: requested })) return true;
  app.quit();
  return false;
}

function electronNotice(): (text: string) => void {
  return (text) => new Notification({ title: "hinge", body: text }).show();
}

async function runMode(opts: RunOptions): Promise<void> {
  if (opts.userData) app.setPath("userData", opts.userData);
  if (!holdSingleInstance(opts.app)) return;
  await app.whenReady();
  // Toasts on Windows are grouped and actioned by AppUserModelId; without a
  // matching one set explicitly, an installed, portable and unpacked build
  // of the same app each gets their own default id and none of them work.
  if (process.platform === "win32") app.setAppUserModelId("net.garulf.hinge");
  const logger = createLogger(join(app.getPath("logs"), "hinge.log"));
  const settingsPath = join(app.getPath("userData"), "settings.json");
  const settings = await loadSettings(settingsPath);
  let placement: DevicePlacement | null = null;
  let quitHinge = (): void => {
    if (!win.isDestroyed()) win.close();
  };
  let workAreaChanged = (): void => {};
  const { win, port } = createPhoneWindow({
    onMoved: () => {
      placement?.moved();
      workAreaChanged();
    },
    showWhenReady: opts.app === null,
    onQuit: () => quitHinge(),
  });
  const earlyLaunches: (string | null)[] = [];
  let secondLaunch = (requested: string | null): void => void earlyLaunches.push(requested);
  app.on("second-instance", (_event, argv, _cwd, additionalData) => secondLaunch(launchRequest(additionalData, argv)));
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

  const phoneHooks: PhoneHooks = { mainVideo: opts.app === null, showMain: () => {}, onPhone: () => {}, clipboardPush: () => 0n };
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
  const notice = (text: string): void => {
    port.postMessage({ kind: "notice", text }, []);
    if (!shell.mainVisible) showNotification(text);
  };
  const popouts = new PopoutManager({
    createWindow: (o) => {
      const popout = createPopoutWindow(o);
      popoutContents.add(popout.webContents);
      popout.onClosed(() => popoutContents.delete(popout.webContents));
      return popout;
    },
    createSession: built.popoutSession ?? (() => noPopoutSession("No phone to open apps from")),
    bindPort: bindPopoutPort,
    identify: async (phone, pkg) => (built.catalog ? built.catalog.identify(phone, pkg) : { label: pkg, icon: null }),
    workArea: () => screen.getDisplayMatching(win.getBounds()).workArea,
    savedBounds: (deviceId, pkg) => restoreBounds(settings.current.devices[deviceId]?.popouts?.[pkg], screen.getAllDisplays().map((d) => d.workArea)),
    saveBounds: (deviceId, pkg, bounds) => {
      settings.saveDevice(deviceId, { popouts: { [pkg]: bounds } }).catch((e) => logger.log(`failed to save the ${pkg} window: ${String(e)}`));
    },
    notice,
    log: logger.log,
    checkRefused: (phone, pkg) => (phone === built.replayPhone ? Promise.resolve(false) : landedOnPhoneScreen(phone, pkg)),
  });

  let currentPhone: ConnectedPhone | null = null;
  const shortcutDeps: DesktopShortcutDeps = {
    platform: process.platform,
    execPath: process.execPath,
    env: process.env,
    userData: app.getPath("userData"),
    appData: app.getPath("appData"),
    home: app.getPath("home"),
    identify: async (pkg) => (built.catalog && currentPhone ? built.catalog.identify(currentPhone, pkg) : { label: pkg, icon: null }),
    fallbackIcon: async () => nativeImage.createFromPath(appIconPath()).resize({ width: 256, height: 256 }).toPNG(),
    writeShortcutLink: (path, operation, options) => electronShell.writeShortcutLink(path, operation, options),
    readShortcutLink: (path) => {
      try {
        return electronShell.readShortcutLink(path);
      } catch {
        return null;
      }
    },
    log: logger.log,
  };
  const mainSink = bindSource(source, port, {
    logPath: logger.path,
    onStatus: (status) => placement?.status(status),
    onRendererMessage: (msg) => {
      if (msg.kind === "popout-open") popouts.open(msg.pkg);
      else if (msg.kind === "popout-current") void popOutCurrent({ phone: () => currentPhone, dumpActivities, popouts, notice, log: logger.log });
      else if (msg.kind === "create-shortcut") void createDesktopShortcut(shortcutDeps, msg.pkg).then(notice);
      else if (msg.kind === "apps-request") void answerAppsRequest(built.catalog ?? null, currentPhone, msg.id, (answer) => port.postMessage(answer, []));
    },
  });

  const companion = built.companion ? new CompanionOwner({ create: built.companion, sink: mainSink, log: logger.log }) : null;
  phoneHooks.onPhone = (phone) => {
    currentPhone = phone;
    built.catalog?.setPhone(phone);
    popouts.setPhone(phone);
    companion?.phone(phone);
  };
  phoneHooks.clipboardPush = (content) => companion?.beginPush(content) ?? 0n;

  let shuttingDown: Promise<void> | null = null;
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });
  quitHinge = () => {
    if (shuttingDown) return;
    quitting = true;
    shuttingDown = shutdownWithin(SHUTDOWN_LIMIT_MS, [
      async () => {
        await popouts.closeAll();
        await settings.settled();
      },
      async () => companion?.stop(),
      async () => {
        await source.stop().catch(() => {});
        await closeRecording();
      },
    ]).then(() => app.quit());
  };

  const shell = new AppShell(
    {
      showWindow: () => focusWindow(win),
      hideWindow: () => {
        if (!win.isDestroyed()) win.hide();
      },
      setMainVideo,
      companionWanted: (on) => companion?.wanted(on),
      popouts,
      quit: () => quitHinge(),
    },
    { startHidden: opts.app !== null },
  );
  phoneHooks.showMain = () => shell.showMain();

  win.on("close", (e) => {
    placement?.flush();
    if (quitting || shell.closeRequested() === "quit") return;
    e.preventDefault();
  });
  secondLaunch = (requested) => shell.launch(requested);

  let tray: Tray | null = createTray({
    showPhone: () => shell.showMain(),
    openApp: () => {
      shell.showMain();
      port.postMessage({ kind: "open-picker" }, []);
    },
    quit: () => quitHinge(),
    log: logger.log,
  });

  if (built.replayPhone) popouts.setPhone(built.replayPhone);
  shell.start();
  if (opts.app) popouts.open(opts.app);
  for (const requested of earlyLaunches.splice(0)) shell.launch(requested);

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
