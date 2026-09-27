import { posix } from "node:path";

export const SCRCPY_SERVER_VERSION = "4.1";

export interface VendorPathOptions {
  packaged: boolean;
  resourcesPath: string;
  appRoot: string;
  platform: NodeJS.Platform;
}

export function vendorPaths(opts: VendorPathOptions): { adb: string; scrcpyServer: string; agent: string } {
  const base = posix.join(opts.packaged ? opts.resourcesPath : opts.appRoot, "vendor");
  const isWin = opts.platform === "win32";
  return {
    adb: posix.join(base, isWin ? "platform-tools-win" : "platform-tools-linux", isWin ? "adb.exe" : "adb"),
    scrcpyServer: posix.join(base, `scrcpy-server-v${SCRCPY_SERVER_VERSION}`),
    agent: posix.join(base, "hinge-agent.jar"),
  };
}
