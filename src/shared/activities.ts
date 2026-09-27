const DISPLAY_HEADER = /^\s*Display #(\d+)/;
const RESUMED_LINE = /^\s*(?:mResumedActivity:|topResumedActivity=|Resumed:)\s*ActivityRecord\{\S+ u\d+ ([^\s/}]+)\//;
const TASK_HEADER = /^\s*\* Task\{/;
const HISTORY_RECORD = /^\s*\* Hist\s+#\d+: ActivityRecord\{\S+ u\d+ ([^\s/}]+)\//;

const SYSTEM_UI = "com.android.systemui";
/** Samsung's One UI Home, in case its task is not dumped as type=home. */
const KNOWN_LAUNCHERS = new Set(["com.sec.android.app.launcher"]);
const PHONE_SCREEN = 0;

/** Each display's resumed package from `dumpsys activity activities`; the first resumed activity in a display's section is its top one. */
export function resumedByDisplay(dumpsysText: string): Map<number, string> {
  const resumed = new Map<number, string>();
  let display: number | null = null;
  for (const line of dumpsysText.split("\n")) {
    const header = DISPLAY_HEADER.exec(line);
    if (header) {
      display = Number(header[1]);
      continue;
    }
    const match = display === null ? null : RESUMED_LINE.exec(line);
    if (match && display !== null && !resumed.has(display)) resumed.set(display, match[1]);
  }
  return resumed;
}

/** The packages of the activities in type=home tasks: the launcher. */
export function homePackages(dumpsysText: string): Set<string> {
  const home = new Set<string>();
  let inHome = false;
  for (const line of dumpsysText.split("\n")) {
    if (DISPLAY_HEADER.test(line)) inHome = false;
    else if (TASK_HEADER.test(line)) inHome = line.includes(" type=home");
    else if (inHome) {
      const record = HISTORY_RECORD.exec(line);
      if (record) home.add(record[1]);
    }
  }
  return home;
}

/** The app on the phone's own screen, or null when that is the launcher or System UI. */
export function currentAppPackage(dumpsysText: string): string | null {
  const pkg = resumedByDisplay(dumpsysText).get(PHONE_SCREEN);
  if (!pkg || pkg === SYSTEM_UI || KNOWN_LAUNCHERS.has(pkg) || homePackages(dumpsysText).has(pkg)) return null;
  return pkg;
}

export function resumedOnPhoneScreen(dumpsysText: string, pkg: string): boolean {
  return resumedByDisplay(dumpsysText).get(PHONE_SCREEN) === pkg;
}

/** The app did not move to its pop-out's display: it is still on the phone screen and resumed nowhere else. */
export function stayedOnPhoneScreen(dumpsysText: string, pkg: string): boolean {
  const resumed = resumedByDisplay(dumpsysText);
  if (resumed.get(PHONE_SCREEN) !== pkg) return false;
  return [...resumed].every(([display, other]) => display === PHONE_SCREEN || other !== pkg);
}
