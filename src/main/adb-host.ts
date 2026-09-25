import { execFile } from "node:child_process";
import type { Adb, AdbServerClient as AdbServerClientType } from "@yume-chan/adb";
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { transportOf, type DeviceSummary } from "./transport";

export interface ServerProbe {
  isRunning(): Promise<boolean>;
}

export interface Spawner {
  startServer(adbPath: string): Promise<void>;
}

class DefaultProbe implements ServerProbe {
  constructor(private readonly client: AdbServerClient) {}

  async isRunning(): Promise<boolean> {
    try {
      await this.client.getVersion();
      return true;
    } catch {
      return false;
    }
  }
}

class DefaultSpawner implements Spawner {
  async startServer(adbPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile(adbPath, ["start-server"], { windowsHide: true }, (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve();
      });
    });
  }
}

const IDENTIFY_TIMEOUT_MS = 3000;

function toDeviceSummary(device: AdbServerClientType.Device): DeviceSummary {
  return {
    serial: device.serial,
    state: device.state,
    model: device.model ?? null,
    device: device.device ?? null,
    transport: transportOf(device.serial),
  };
}

export class AdbHost {
  readonly client: AdbServerClient;

  private readonly adbPath: string;
  private readonly probe: ServerProbe;
  private readonly spawner: Spawner;
  private readonly identifyTimeoutMs: number;

  constructor(opts: { adbPath: string; host?: string; port?: number; probe?: ServerProbe; spawner?: Spawner; identifyTimeoutMs?: number }) {
    this.adbPath = opts.adbPath;
    const connector = new AdbServerNodeTcpConnector({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 5037,
    });
    this.client = new AdbServerClient(connector);
    this.probe = opts.probe ?? new DefaultProbe(this.client);
    this.spawner = opts.spawner ?? new DefaultSpawner();
    this.identifyTimeoutMs = opts.identifyTimeoutMs ?? IDENTIFY_TIMEOUT_MS;
  }

  async ensureServer(): Promise<"existing" | "spawned"> {
    if (await this.probe.isRunning()) return "existing";
    await this.spawner.startServer(this.adbPath);
    return "spawned";
  }

  async watch(
    onChange: (devices: DeviceSummary[]) => void,
    onError?: (err: Error) => void,
  ): Promise<() => Promise<void>> {
    const observer = await this.client.trackDevices({
      includeStates: ["device", "unauthorized", "authorizing", "offline"],
    });
    const emit = (devices: readonly AdbServerClientType.Device[]) => onChange(devices.map(toDeviceSummary));
    const offList = observer.onListChange(emit);
    const offError = observer.onError((err) => onError?.(err));
    emit(observer.current);
    return async () => {
      offList();
      offError();
      await observer.close();
    };
  }

  async open(serial: string): Promise<Adb> {
    return this.client.createAdb({ serial });
  }

  /** The phone's ro.serialno over this transport; null when it is empty or the shell does not answer in time. */
  async identify(serial: string): Promise<string | null> {
    const adb = await this.open(serial);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), this.identifyTimeoutMs);
      });
      const serialno = (await Promise.race([adb.getProp("ro.serialno"), timeout])).trim();
      return serialno === "" ? null : serialno;
    } finally {
      clearTimeout(timer);
      await adb.close().catch(() => {});
    }
  }
}
