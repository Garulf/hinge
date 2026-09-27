/** A launchable app on the phone. versionCode is null when the list came from the launcher query, which does not report it. */
export interface AppEntry {
  pkg: string;
  label: string;
  versionCode: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The agent's `apps` output. Throws when it is not a JSON array. */
export function parseAgentApps(json: string): AppEntry[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("the agent's app list is not an array");
  const apps: AppEntry[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.pkg !== "string" || item.pkg === "") continue;
    const label = typeof item.label === "string" && item.label.trim() !== "" ? item.label : item.pkg;
    const versionCode = typeof item.versionCode === "number" && Number.isFinite(item.versionCode) ? item.versionCode : null;
    apps.push({ pkg: item.pkg, label, versionCode });
  }
  return apps;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The agent's `icons` output: each package's PNG. Throws when it is not a JSON object. */
export function parseAgentIcons(json: string): Record<string, Uint8Array> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error("the agent's icons are not an object");
  const icons: Record<string, Uint8Array> = {};
  for (const [pkg, png] of Object.entries(parsed)) {
    if (typeof png === "string") icons[pkg] = decodeBase64(png);
  }
  return icons;
}

const RECENT_HEADER = /^(\s*)\* Recent #\d+:/;
const AFFINITY = /\bA=(?:\d+:)?([A-Za-z][\w.]*)/;
const COMPONENT = /\bcmp=([A-Za-z][\w.]*)\//;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function recentPackage(header: string, body: string[]): string | null {
  const affinity = AFFINITY.exec(header);
  if (affinity) return affinity[1];
  for (const line of [header, ...body]) {
    const component = COMPONENT.exec(line);
    if (component) return component[1];
  }
  return null;
}

/**
 * The packages of `dumpsys activity recents`, most recent first, once each.
 * A block runs from its `Recent #N` header to the next line indented no
 * deeper than the header. System entries such as the launcher are kept; the
 * caller filters them.
 */
export function parseRecents(dumpsysText: string): string[] {
  const packages: string[] = [];
  const lines = dumpsysText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const match = RECENT_HEADER.exec(header);
    if (!match) continue;
    const depth = match[1].length;
    const body: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || indentOf(lines[i + 1]) > depth)) body.push(lines[++i]);
    const pkg = recentPackage(header, body);
    if (pkg && !packages.includes(pkg)) packages.push(pkg);
  }
  return packages;
}

const LAUNCHER_COMPONENT = /^\s*([A-Za-z][\w.]*)\/[\w.$]+\s*$/;

/** The packages `cmd package query-activities --brief` lists, once each, labelled by package since the query does not give labels. */
export function parseLauncherActivities(text: string): AppEntry[] {
  const apps: AppEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = LAUNCHER_COMPONENT.exec(line);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    apps.push({ pkg: match[1], label: match[1], versionCode: null });
  }
  return apps;
}
