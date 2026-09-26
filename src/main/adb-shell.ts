import type { Adb } from "@yume-chan/adb";

/** Runs a one-shot adb shell command and returns its stdout as text. */
export async function runShellText(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell) throw new Error("device does not support the shell protocol");
  const result = await shell.spawn(command).wait();
  return new TextDecoder().decode(result.stdout);
}
