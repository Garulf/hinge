import type { DeviceCommand, DeviceCommandResult, RendererToMain } from "../../shared/wire";

const TIMEOUT_MS = 60_000;

/** Pairs each device command with its result by id; a command main never answers (it has no device access, as in a replay) times out. */
export class DeviceCommands {
  readonly #send: (msg: RendererToMain) => void;
  readonly #pending = new Map<string, { resolve: (r: DeviceCommandResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #nextId = 0;

  constructor(send: (msg: RendererToMain) => void) {
    this.#send = send;
  }

  request(command: DeviceCommand, timeoutMs = TIMEOUT_MS): Promise<DeviceCommandResult> {
    const id = `cmd-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("no answer from the device host"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ kind: "device-command", id, command });
    });
  }

  result(id: string, result: DeviceCommandResult): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    pending.resolve(result);
  }
}

/** A pairing code is the six digits the phone shows under "Pair device with pairing code". */
export function validPairingCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/** host:port with a port in range; the host is anything non-empty (an IPv4 address in practice). */
export function validHostPort(value: string): boolean {
  const match = /^(.+):(\d{1,5})$/.exec(value.trim());
  if (!match) return false;
  const port = Number(match[2]);
  return port > 0 && port < 65536;
}

/** The address to connect to after pairing, from the pairing address's host and the connect port the user typed. */
export function connectAddress(pairHostPort: string, port: string): string | null {
  const host = pairHostPort.trim().replace(/:\d+$/, "");
  const address = `${host}:${port.trim()}`;
  return validHostPort(address) ? address : null;
}
