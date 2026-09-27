import type { Adb } from "@yume-chan/adb";

/** Runs a one-shot adb shell command and returns its stdout as text. */
export async function runShellText(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell) throw new Error("device does not support the shell protocol");
  const result = await shell.spawn(command).wait();
  return new TextDecoder().decode(result.stdout);
}

/** Like runShellText, but a non-zero exit throws with the command's stderr, and aborting the signal kills the command. */
export async function runShellChecked(adb: Adb, command: string, signal?: AbortSignal): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell) throw new Error("device does not support the shell protocol");
  const result = await shell.spawn(command, signal).wait();
  const decoder = new TextDecoder();
  if (result.exitCode !== 0) throw new Error(`exited with ${result.exitCode}: ${decoder.decode(result.stderr).trim()}`);
  return decoder.decode(result.stdout);
}

export const SHELL_TIMEOUT_MS = 15_000;

/** Rejects once timeoutMs passes, aborting the signal handed to work so a command still running is killed. */
export function withinTimeout<T>(work: (signal: AbortSignal) => Promise<T>, what: string, timeoutMs: number = SHELL_TIMEOUT_MS): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`${what} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  return Promise.race([work(abort.signal), timeout]).finally(() => clearTimeout(timer));
}
