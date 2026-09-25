import { app } from "electron";
import { AdbHost } from "./adb-host";
import { bindSource, DeviceSource } from "./app-controller";
import { parseArgs } from "./cli";
import type { MediaSource } from "./media-source";
import { ReplaySource } from "./replay-source";
import { DEFAULT_STREAM_SETTINGS } from "./scrcpy-init";
import { vendorPaths } from "./vendor-paths";
import { createPhoneWindow, portLikeOf } from "./window";

const mode = parseArgs(process.argv);

async function runMode(opts: { serial: string | null; replay: string | null }): Promise<void> {
  await app.whenReady();
  const { win, port } = createPhoneWindow();

  let source: MediaSource;
  if (opts.replay) {
    source = await ReplaySource.fromFile(opts.replay, { loop: false });
  } else {
    const paths = vendorPaths({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appRoot: app.getAppPath(),
      platform: process.platform,
    });
    const host = new AdbHost({ adbPath: paths.adb });
    await host.ensureServer();
    source = new DeviceSource({
      host,
      serverPath: paths.scrcpyServer,
      settings: DEFAULT_STREAM_SETTINGS,
      preferredSerial: opts.serial,
    });
  }

  bindSource(source, portLikeOf(port));
  win.on("closed", () => void source.stop());
}

if (mode.mode === "run") {
  void runMode(mode);
}

app.on("window-all-closed", () => app.quit());
