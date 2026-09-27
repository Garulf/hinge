import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adb } from "@yume-chan/adb";
import { PushReadableStream } from "@yume-chan/stream-extra";
import { parseAgentApps, parseAgentIcons, parseLauncherActivities, parseRecents, type AppEntry } from "../shared/app-catalog";
import type { MainToRenderer } from "../shared/wire";
import { runShellChecked, SHELL_TIMEOUT_MS, withinTimeout } from "./adb-shell";
import { reasonOf } from "./error-text";
import type { ConnectedPhone } from "./app-controller";
import type { AppIdentity } from "./popout-manager";

export const AGENT_REMOTE_PATH = "/data/local/tmp/hinge-agent.jar";
const AGENT_COMMAND = `CLASSPATH=${AGENT_REMOTE_PATH} app_process / net.garulf.hinge.Agent`;
const LAUNCHER_QUERY = "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER";
const RECENTS_DUMP = "dumpsys activity recents";
const ICON_PX = 96;
const ICON_BATCH = 20;
const MAX_RECENTS = 8;

export interface AppsResult {
  apps: AppEntry[];
  /** Packages from `apps`, most recent first. */
  recents: string[];
  /** Each package's icon as a data: URL; packages without one are absent. */
  icons: Record<string, string>;
  /** Why the list is only package names, or empty; null when the agent answered. */
  error: string | null;
}

export type ShellRunner = (adb: Adb, command: string, signal?: AbortSignal) => Promise<string>;

export interface AppCatalogOptions {
  agentPath: string;
  cacheDir: string;
  runShell?: ShellRunner;
  push?: (adb: Adb, local: string, remote: string) => Promise<void>;
  log(line: string): void;
  /** The agent has no watchdog, so a binder call that never returns would otherwise leave a request waiting forever. */
  timeoutMs?: number;
}

/** What is known about one phone connection; dropped when the connection goes. */
interface Connection {
  adb: Adb;
  pushed: Promise<void> | null;
  agentApps: AppEntry[] | null;
}

async function pushLocalFile(adb: Adb, local: string, remote: string): Promise<void> {
  const bytes = await readFile(local);
  await adb.sync.write({
    path: remote,
    readable: new PushReadableStream<Uint8Array>((controller) => {
      controller.enqueue(bytes);
      controller.close();
    }),
  });
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function iconFileName(app: AppEntry): string {
  return `${app.pkg}@${app.versionCode ?? 0}.png`;
}

function pngDataUrls(icons: Map<string, Uint8Array>): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [pkg, png] of icons) urls[pkg] = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  return urls;
}

/** The phone's icon folder, or null when its identity leaves no usable folder name (empty, or only dots), so nothing is cached. */
function iconDir(cacheDir: string, deviceId: string): string | null {
  const name = deviceId.replace(/[^\w.+-]/g, "_");
  return /^\.*$/.test(name) ? null : join(cacheDir, name);
}

/**
 * The phone's launchable apps with their labels, icons and recents, read by
 * the hinge agent (pushed once per connection) and falling back to the
 * launcher query's package names when the agent fails. Icons are cached on
 * disk per phone identity and app version, so they outlive the connection.
 */
export class AppCatalog {
  readonly #opts: AppCatalogOptions;
  readonly #runShell: ShellRunner;
  readonly #push: NonNullable<AppCatalogOptions["push"]>;
  readonly #timeoutMs: number;
  #connection: Connection | null = null;

  constructor(opts: AppCatalogOptions) {
    this.#opts = opts;
    this.#runShell = opts.runShell ?? runShellChecked;
    this.#push = opts.push ?? pushLocalFile;
    this.#timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  }

  setPhone(phone: ConnectedPhone | null): void {
    if (this.#connection && this.#connection.adb !== phone?.adb) this.#connection = null;
  }

  /** onListed gets the list with only the cached icons first, when some are still to be fetched; the answer has them all. */
  async apps(phone: ConnectedPhone, onListed?: (early: AppsResult) => void): Promise<AppsResult> {
    const [listed, recents] = await Promise.all([this.#listApps(phone), this.#recents(phone)]);
    const packages = new Set(listed.apps.map((app) => app.pkg));
    const result = (icons: Map<string, Uint8Array>): AppsResult => ({
      apps: listed.apps,
      recents: recents.filter((pkg) => packages.has(pkg)).slice(0, MAX_RECENTS),
      icons: pngDataUrls(icons),
      error: listed.error,
    });
    if (listed.error !== null) return result(new Map());
    const dir = iconDir(this.#opts.cacheDir, phone.deviceId);
    const { icons, missing } = await this.#cachedIcons(dir, listed.apps);
    if (missing.length === 0) return result(icons);
    onListed?.(result(icons));
    await this.#fetchIcons(phone, dir, missing, icons);
    return result(icons);
  }

  /** Never throws: a failure is logged and answered with the package name. */
  async identify(phone: ConnectedPhone, pkg: string): Promise<AppIdentity> {
    try {
      const apps = this.#connectionFor(phone).agentApps ?? (await this.#agentApps(phone));
      const app = apps.find((a) => a.pkg === pkg);
      if (!app) return { label: pkg, icon: null };
      const dir = iconDir(this.#opts.cacheDir, phone.deviceId);
      const { icons, missing } = await this.#cachedIcons(dir, [app]);
      await this.#fetchIcons(phone, dir, missing, icons);
      return { label: app.label, icon: icons.get(pkg) ?? null };
    } catch (e) {
      this.#opts.log(`identifying ${pkg} failed: ${reasonOf(e)}`);
      return { label: pkg, icon: null };
    }
  }

  #connectionFor(phone: ConnectedPhone): Connection {
    if (this.#connection?.adb !== phone.adb) this.#connection = { adb: phone.adb, pushed: null, agentApps: null };
    return this.#connection;
  }

  async #listApps(phone: ConnectedPhone): Promise<{ apps: AppEntry[]; error: string | null }> {
    try {
      return { apps: await this.#agentApps(phone), error: null };
    } catch (e) {
      const reason = reasonOf(e);
      this.#opts.log(`app list from the hinge agent failed, falling back to package names: ${reason}`);
      const error = `App names and icons are unavailable: ${reason}`;
      try {
        return { apps: parseLauncherActivities(await this.#shell(phone.adb, LAUNCHER_QUERY, "the launcher query")), error };
      } catch (fallback) {
        this.#opts.log(`launcher query failed: ${reasonOf(fallback)}`);
        return { apps: [], error };
      }
    }
  }

  async #agentApps(phone: ConnectedPhone): Promise<AppEntry[]> {
    const connection = this.#connectionFor(phone);
    await this.#ensurePushed(connection);
    const apps = parseAgentApps(await this.#shell(phone.adb, `${AGENT_COMMAND} apps`, "the agent's app list"));
    connection.agentApps = apps;
    return apps;
  }

  #ensurePushed(connection: Connection): Promise<void> {
    connection.pushed ??= withinTimeout(() => this.#push(connection.adb, this.#opts.agentPath, AGENT_REMOTE_PATH), "pushing the agent", this.#timeoutMs).catch((e: unknown) => {
      connection.pushed = null;
      throw e;
    });
    return connection.pushed;
  }

  async #recents(phone: ConnectedPhone): Promise<string[]> {
    try {
      return parseRecents(await this.#shell(phone.adb, RECENTS_DUMP, "the recents dump"));
    } catch (e) {
      this.#opts.log(`recent apps unavailable: ${reasonOf(e)}`);
      return [];
    }
  }

  async #cachedIcons(dir: string | null, apps: AppEntry[]): Promise<{ icons: Map<string, Uint8Array>; missing: AppEntry[] }> {
    const cached = await Promise.all(apps.map((app) => (dir ? readFile(join(dir, iconFileName(app))).catch(() => null) : null)));
    const icons = new Map<string, Uint8Array>();
    const missing: AppEntry[] = [];
    apps.forEach((app, i) => {
      const png = cached[i];
      if (png) icons.set(app.pkg, png);
      else missing.push(app);
    });
    return { icons, missing };
  }

  /** Asks the agent for the missing icons into icons, caching each; a failed batch is logged and ends the asking. */
  async #fetchIcons(phone: ConnectedPhone, dir: string | null, missing: AppEntry[], icons: Map<string, Uint8Array>): Promise<void> {
    if (missing.length === 0) return;
    try {
      if (dir) await mkdir(dir, { recursive: true });
      for (const batch of chunks(missing, ICON_BATCH)) {
        const command = `${AGENT_COMMAND} icons ${ICON_PX} ${batch.map((app) => app.pkg).join(" ")}`;
        const fetched = parseAgentIcons(await this.#shell(phone.adb, command, "the agent's icons"));
        for (const app of batch) {
          const png = fetched[app.pkg];
          if (!png) continue;
          icons.set(app.pkg, png);
          if (dir) await writeFile(join(dir, iconFileName(app)), png).catch((e: unknown) => this.#opts.log(`could not cache the icon of ${app.pkg}: ${reasonOf(e)}`));
        }
      }
    } catch (e) {
      this.#opts.log(`app icons unavailable: ${reasonOf(e)}`);
    }
  }

  #shell(adb: Adb, command: string, what: string): Promise<string> {
    return withinTimeout((signal) => this.#runShell(adb, command, signal), what, this.#timeoutMs);
  }
}

export type AppsMessage = Extract<MainToRenderer, { kind: "apps" }>;

/**
 * The main window's "apps-request", answered for the phone connected now:
 * the list with the cached icons as soon as it is known, then again with
 * every icon once the missing ones are fetched. Every answer carries the
 * request's id.
 */
export async function answerAppsRequest(catalog: AppCatalog | null, phone: ConnectedPhone | null, id: number, send: (msg: AppsMessage) => void): Promise<void> {
  if (!catalog || !phone) return send({ kind: "apps", id, apps: [], recents: [], icons: {}, error: "No phone connected" });
  try {
    send({ kind: "apps", id, ...(await catalog.apps(phone, (early) => send({ kind: "apps", id, ...early }))) });
  } catch (e) {
    send({ kind: "apps", id, apps: [], recents: [], icons: {}, error: `Could not list the phone's apps: ${reasonOf(e)}` });
  }
}
