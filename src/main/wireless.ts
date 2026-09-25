import { AdbServerClient, type Adb } from "@yume-chan/adb";

export interface MdnsService {
  name: string;
  service: string;
  address: string;
}

/**
 * The real Tango/adb calls, isolated so pairing, connecting and switching a
 * USB device to Wi-Fi can be driven by fakes in tests, without a real device
 * or adb server.
 */
export interface WirelessDeps {
  pair(hostPort: string, code: string): Promise<void>;
  connect(address: string): Promise<void>;
  disconnect(address: string): Promise<void>;
  mdnsServices(): Promise<MdnsService[]>;
  setTcpIpPort(adb: Adb, port: number): Promise<void>;
  /** null when the device has no address on wlan0 (Wi-Fi off, no connection, or the shell command failed). */
  wlanIp(adb: Adb): Promise<string | null>;
}

const CONNECT_SERVICE = "_adb-tls-connect._tcp";

/** adb answers a connect to an address it already has with an error, but the phone is reachable, which is all a caller wants. */
export function isAlreadyConnected(e: unknown): boolean {
  return e instanceof AdbServerClient.AlreadyConnectedError || (e instanceof Error && e.name === "AlreadyConnectedError");
}

export async function connectOrAlreadyConnected(deps: Pick<WirelessDeps, "connect">, address: string): Promise<void> {
  try {
    await deps.connect(address);
  } catch (e) {
    if (!isAlreadyConnected(e)) throw e;
  }
}

function hostOf(hostPort: string): string {
  const lastColon = hostPort.lastIndexOf(":");
  return lastColon === -1 ? hostPort : hostPort.slice(0, lastColon);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PairResult {
  paired: true;
  /** null when pairing succeeded but no matching mDNS connect service was found within the poll window (ask for the connect port instead), or when a matching service was found but connecting to it failed. */
  connectedAddress: string | null;
  /** Set alongside a null connectedAddress when a connect service was found but connect() itself failed, so the caller can show why. */
  message?: string;
}

/**
 * `client.wireless.pair` only establishes trust; the device is reachable
 * for mirroring only once connected to its separate mDNS-advertised connect
 * service (a different port from the pairing one), which can take a moment
 * to appear after pairing completes.
 */
export async function pairNewDevice(
  deps: WirelessDeps,
  hostPort: string,
  code: string,
  opts?: { pollAttempts?: number; pollDelayMs?: number; delay?: (ms: number) => Promise<void> },
): Promise<PairResult> {
  await deps.pair(hostPort, code);

  const host = hostOf(hostPort);
  const attempts = opts?.pollAttempts ?? 3;
  const delayMs = opts?.pollDelayMs ?? 500;
  const delay = opts?.delay ?? defaultDelay;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const services = await deps.mdnsServices();
    const match = services.find((s) => s.service === CONNECT_SERVICE && hostOf(s.address) === host);
    if (match) {
      // Pairing itself already succeeded at this point; a failed connect is
      // reported as "ask for the port" rather than failing the whole pair.
      try {
        await connectOrAlreadyConnected(deps, match.address);
        return { paired: true, connectedAddress: match.address };
      } catch (e) {
        return { paired: true, connectedAddress: null, message: String(e) };
      }
    }
    if (attempt < attempts - 1) await delay(delayMs);
  }
  return { paired: true, connectedAddress: null };
}

const WIFI_PORT = 5555;
const CONNECT_RETRY_ATTEMPTS = 10;
const CONNECT_RETRY_DELAY_MS = 300;

/** `adb tcpip 5555` then `adb connect <device-ip>:5555`, the device's own ip from `ip -4 addr show wlan0`. */
export async function switchDeviceToWifi(
  deps: WirelessDeps,
  adb: Adb,
  opts?: { delay?: (ms: number) => Promise<void> },
): Promise<string> {
  const ip = await deps.wlanIp(adb);
  if (!ip) throw new Error("could not find the device's Wi-Fi (wlan0) IP address; is Wi-Fi on?");
  await deps.setTcpIpPort(adb, WIFI_PORT);
  const address = `${ip}:${WIFI_PORT}`;
  const delay = opts?.delay ?? defaultDelay;

  // setTcpIpPort restarts adbd in TCP mode; connect() can fail transiently
  // for a moment while it comes back up.
  let lastError: unknown;
  for (let attempt = 0; attempt < CONNECT_RETRY_ATTEMPTS; attempt++) {
    try {
      await connectOrAlreadyConnected(deps, address);
      return address;
    } catch (e) {
      lastError = e;
      if (attempt < CONNECT_RETRY_ATTEMPTS - 1) await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/** Matches the first `inet a.b.c.d/nn` line, which is how `ip -4 addr show wlan0` reports the interface's address. */
export function parseWlanIp(output: string): string | null {
  const match = /inet (\d+\.\d+\.\d+\.\d+)/.exec(output);
  return match ? match[1] : null;
}

async function shellText(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell) throw new Error("device does not support the shell protocol");
  // .wait() lives on the Promise spawn() returns, not on the resolved process.
  const result = await shell.spawn(command).wait();
  return new TextDecoder().decode(result.stdout);
}

export function createWirelessDeps(client: AdbServerClient): WirelessDeps {
  return {
    pair: (hostPort, code) => client.wireless.pair(hostPort, code),
    connect: (address) => client.wireless.connect(address),
    disconnect: (address) => client.wireless.disconnect(address),
    mdnsServices: () => client.mDns.getServices(),
    setTcpIpPort: async (adb, port) => {
      await adb.tcpip.setPort(port);
    },
    wlanIp: async (adb) => parseWlanIp(await shellText(adb, "ip -4 addr show wlan0")),
  };
}
