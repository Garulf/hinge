import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adb } from "@yume-chan/adb";
import { PushReadableStream } from "@yume-chan/stream-extra";
import { parseAgentApps, parseAgentIcons, parseLauncherActivities, parseRecents, type AppEntry } from "../shared/app-catalog";
import type { MainToRenderer } from "../shared/wire";
import { runShellChecked, SHELL_TIMEOUT_MS, withinTimeout } from "./adb-shell";
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

function reasonOf(e: unknown): string {
  return String(e).replace(/^Error:\s*/, "");
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function iconFileName(app: AppEntry): string {
  return `${app.pkg}@${app.versionCode ?? 0}.png`;
}

function pngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
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

  async apps(phone: ConnectedPhone): Promise<AppsResult> {
    const [listed, recents] = await Promise.all([this.#listApps(phone), this.#recents(phone)]);
    const packages = new Set(listed.apps.map((app) => app.pkg));
    const icons: Record<string, string> = {};
    if (listed.error === null) {
      for (const [pkg, png] of await this.#icons(phone, listed.apps)) icons[pkg] = pngDataUrl(png);
    }
    return {
      apps: listed.apps,
      recents: recents.filter((pkg) => packages.has(pkg)).slice(0, MAX_RECENTS),
      icons,
      error: listed.error,
    };
  }

  /** Never throws: a failure is logged and answered with the package name. */
  async identify(phone: ConnectedPhone, pkg: string): Promise<AppIdentity> {
    try {
      const apps = this.#connectionFor(phone).agentApps ?? (await this.#agentApps(phone));
      const app = apps.find((a) => a.pkg === pkg);
      if (!app) return { label: pkg, icon: null };
      const icons = await this.#icons(phone, [app]);
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

  /** The cached icons, after asking the agent for the missing ones; a failed batch is logged and ends the asking. */
  async #icons(phone: ConnectedPhone, apps: AppEntry[]): Promise<Map<string, Uint8Array>> {
    const dir = join(this.#opts.cacheDir, phone.deviceId.replace(/[^\w.+-]/g, "_"));
    const cached = await Promise.all(apps.map((app) => readFile(join(dir, iconFileName(app))).catch(() => null)));
    const icons = new Map<string, Uint8Array>();
    const missing: AppEntry[] = [];
    apps.forEach((app, i) => {
      const png = cached[i];
      if (png) icons.set(app.pkg, png);
      else missing.push(app);
    });
    if (missing.length === 0) return icons;
    try {
      await mkdir(dir, { recursive: true });
      for (const batch of chunks(missing, ICON_BATCH)) {
        const command = `${AGENT_COMMAND} icons ${ICON_PX} ${batch.map((app) => app.pkg).join(" ")}`;
        const fetched = parseAgentIcons(await this.#shell(phone.adb, command, "the agent's icons"));
        for (const app of batch) {
          const png = fetched[app.pkg];
          if (!png) continue;
          icons.set(app.pkg, png);
          await writeFile(join(dir, iconFileName(app)), png);
        }
      }
    } catch (e) {
      this.#opts.log(`app icons unavailable: ${reasonOf(e)}`);
    }
    return icons;
  }

  #shell(adb: Adb, command: string, what: string): Promise<string> {
    return withinTimeout((signal) => this.#runShell(adb, command, signal), what, this.#timeoutMs);
  }
}

export type AppsMessage = Extract<MainToRenderer, { kind: "apps" }>;

/** The main window's "apps-request", answered for the phone connected now. */
export async function answerAppsRequest(catalog: AppCatalog | null, phone: ConnectedPhone | null): Promise<AppsMessage> {
  if (!catalog || !phone) return { kind: "apps", apps: [], recents: [], icons: {}, error: "No phone connected" };
  try {
    return { kind: "apps", ...(await catalog.apps(phone)) };
  } catch (e) {
    return { kind: "apps", apps: [], recents: [], icons: {}, error: `Could not list the phone's apps: ${reasonOf(e)}` };
  }
}
