import { app } from "electron";
import { AdbHost } from "./adb-host";
import { bindSource, DeviceSource } from "./app-controller";
import { parseArgs } from "./cli";
import type { MediaSink, MediaSource } from "./media-source";
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

async function buildSource(opts: { serial: string | null; replay: string | null }): Promise<MediaSource> {
  if (opts.replay) return ReplaySource.fromFile(opts.replay, { loop: false });

  const paths = vendorPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    platform: process.platform,
  });
  const host = new AdbHost({ adbPath: paths.adb });
  await host.ensureServer();
  return new DeviceSource({
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
  });
}

async function runMode(opts: { serial: string | null; replay: string | null }): Promise<void> {
  await app.whenReady();
  const { win, port } = createPhoneWindow();

  let source: MediaSource;
  try {
    source = await buildSource(opts);
  } catch (e) {
    source = errorSource(String(e));
  }

  bindSource(source, portLikeOf(port));
  win.on("closed", () => void source.stop());
}

if (mode.mode === "run") {
  void runMode(mode);
}

app.on("window-all-closed", () => app.quit());
