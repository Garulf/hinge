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
