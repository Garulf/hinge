import { mkdtemp, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { Adb } from "@yume-chan/adb";
import type { ConnectedPhone } from "../../src/main/app-controller";
import { AGENT_REMOTE_PATH, AppCatalog, answerAppsRequest, type AppCatalogOptions, type AppsMessage } from "../../src/main/app-catalog";
import type { AppEntry } from "../../src/shared/app-catalog";

// Both *-aosp.txt fixtures are written from the AOSP dump formats, not captured from a real phone.
const RECENTS = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-activity-recents-aosp.txt"), "utf8");
const LAUNCHERS = readFileSync(join(import.meta.dirname, "../fixtures/query-activities-aosp.txt"), "utf8");

const AGENT = `CLASSPATH=${AGENT_REMOTE_PATH} app_process / net.garulf.hinge.Agent`;
const LAUNCHER_QUERY = "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER";

function phone(deviceId = "R5CX1234", adb: Adb = {} as Adb): ConnectedPhone {
  return { adb, serial: deviceId, deviceId, model: "SM-F966B" };
}

function pngFor(pkg: string): Uint8Array {
  return new TextEncoder().encode(`png:${pkg}`);
}

function dataUrl(pkg: string): string {
  return `data:image/png;base64,${Buffer.from(pngFor(pkg)).toString("base64")}`;
}

type Responder = (command: string) => Promise<string | undefined> | string | undefined;

class FakePhone {
  commands: string[] = [];
  pushes: { local: string; remote: string }[] = [];
  apps: AppEntry[] = [];
  recents = RECENTS;
  override: Responder | null = null;

  runShell = async (_adb: Adb, command: string): Promise<string> => {
    this.commands.push(command);
    const overridden = this.override ? await this.override(command) : undefined;
    if (overridden !== undefined) return overridden;
    if (command === `${AGENT} apps`) return JSON.stringify(this.apps);
    if (command.startsWith(`${AGENT} icons 96 `)) {
      const pkgs = command.slice(`${AGENT} icons 96 `.length).split(" ");
      return JSON.stringify(Object.fromEntries(pkgs.map((pkg) => [pkg, Buffer.from(pngFor(pkg)).toString("base64")])));
    }
    if (command === "dumpsys activity recents") return this.recents;
    if (command === LAUNCHER_QUERY) return LAUNCHERS;
    throw new Error(`unexpected command ${command}`);
  };

  push = async (_adb: Adb, local: string, remote: string): Promise<void> => {
    this.pushes.push({ local, remote });
  };

  iconCommands(): string[] {
    return this.commands.filter((c) => c.startsWith(`${AGENT} icons`));
  }
}

let cacheDir: string;
let fake: FakePhone;
let logs: string[];

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "hinge-icons-"));
  fake = new FakePhone();
  fake.apps = [
    { pkg: "com.example.chat", label: "Chat", versionCode: 42 },
    { pkg: "com.example.maps", label: "Maps", versionCode: 7 },
    { pkg: "com.example.notes", label: "Notes", versionCode: 3 },
  ];
  logs = [];
});

function catalog(extra: Partial<AppCatalogOptions> = {}): AppCatalog {
  return new AppCatalog({ agentPath: "/app/vendor/hinge-agent.jar", cacheDir, runShell: fake.runShell, push: fake.push, log: (line) => logs.push(line), ...extra });
}

async function cacheIcon(deviceId: string, pkg: string, versionCode: number): Promise<void> {
  await mkdir(join(cacheDir, deviceId), { recursive: true });
  await writeFile(join(cacheDir, deviceId, `${pkg}@${versionCode}.png`), pngFor(pkg));
}

test("apps lists the agent's apps with recents and every icon as a data URL", async () => {
  const result = await catalog().apps(phone());
  expect(result.apps).toEqual(fake.apps);
  expect(result.error).toBeNull();
  expect(result.recents).toEqual(["com.example.chat", "com.example.maps", "com.example.notes"]);
  expect(result.icons).toEqual({
    "com.example.chat": dataUrl("com.example.chat"),
    "com.example.maps": dataUrl("com.example.maps"),
    "com.example.notes": dataUrl("com.example.notes"),
  });
});

test("the agent jar is pushed once for two calls on the same phone connection", async () => {
  const apps = catalog();
  const p = phone();
  await apps.apps(p);
  await apps.apps(p);
  expect(fake.pushes).toEqual([{ local: "/app/vendor/hinge-agent.jar", remote: AGENT_REMOTE_PATH }]);
});

test("two calls racing on a fresh connection still push once", async () => {
  const apps = catalog();
  const p = phone();
  await Promise.all([apps.apps(p), apps.apps(p)]);
  expect(fake.pushes).toHaveLength(1);
});

test("a new phone connection pushes the jar again", async () => {
  const apps = catalog();
  await apps.apps(phone("R5CX1234", {} as Adb));
  const reconnected = phone("R5CX1234", {} as Adb);
  apps.setPhone(reconnected);
  await apps.apps(reconnected);
  expect(fake.pushes).toHaveLength(2);
});

test("a failed push is tried again on the next call", async () => {
  let fail = true;
  const apps = catalog({
    push: async (adb, local, remote) => {
      if (fail) throw new Error("sync failed");
      await fake.push(adb, local, remote);
    },
  });
  const p = phone();
  const first = await apps.apps(p);
  expect(first.error).not.toBeNull();
  fail = false;
  const second = await apps.apps(p);
  expect(second.error).toBeNull();
  expect(fake.pushes).toHaveLength(1);
});

test("icons are requested only for packages without a cached PNG for their version, and written to the cache", async () => {
  await cacheIcon("R5CX1234", "com.example.chat", 42);
  await cacheIcon("R5CX1234", "com.example.maps", 6);
  const result = await catalog().apps(phone());
  expect(fake.iconCommands()).toEqual([`${AGENT} icons 96 com.example.maps com.example.notes`]);
  expect([...(await readFile(join(cacheDir, "R5CX1234", "com.example.notes@3.png")))]).toEqual([...pngFor("com.example.notes")]);
  expect(Object.keys(result.icons).sort()).toEqual(["com.example.chat", "com.example.maps", "com.example.notes"]);
});

test("a second call finds every icon cached and asks for none", async () => {
  const apps = catalog();
  await apps.apps(phone());
  fake.commands = [];
  const result = await apps.apps(phone());
  expect(fake.iconCommands()).toEqual([]);
  expect(Object.keys(result.icons)).toHaveLength(3);
});

test("the icon cache survives a reconnect, keyed by the phone's identity", async () => {
  await catalog().apps(phone("R5CX1234"));
  fake.commands = [];
  const fresh = catalog();
  await fresh.apps(phone("R5CX1234"));
  expect(fake.iconCommands()).toEqual([]);
  await fresh.apps(phone("OTHER99"));
  expect(fake.iconCommands()).toHaveLength(1);
});

test("an identity with characters a file name cannot hold still gets its own cache folder", async () => {
  await catalog().apps(phone("192.168.1.20:5555"));
  expect([...(await readFile(join(cacheDir, "192.168.1.20_5555", "com.example.chat@42.png")))]).toEqual([...pngFor("com.example.chat")]);
});

test("icons are requested in batches of 20", async () => {
  fake.apps = Array.from({ length: 45 }, (_, i) => ({ pkg: `com.example.app${i}`, label: `App ${i}`, versionCode: 1 }));
  await catalog().apps(phone());
  expect(fake.iconCommands().map((c) => c.split(" ").length - `${AGENT} icons 96`.split(" ").length)).toEqual([20, 20, 5]);
});

test("a package the agent could not render is left without an icon", async () => {
  fake.override = (command) => (command.startsWith(`${AGENT} icons`) ? JSON.stringify({ "com.example.chat": Buffer.from(pngFor("com.example.chat")).toString("base64") }) : undefined);
  const result = await catalog().apps(phone());
  expect(Object.keys(result.icons)).toEqual(["com.example.chat"]);
});

test("a failed icons run is logged and skipped, and the apps still come back", async () => {
  fake.override = (command) => {
    if (command.startsWith(`${AGENT} icons`)) throw new Error("hinge-agent: Bitmap exploded");
    return undefined;
  };
  const result = await catalog().apps(phone());
  expect(result.apps).toEqual(fake.apps);
  expect(result.icons).toEqual({});
  expect(result.error).toBeNull();
  expect(logs.some((l) => l.includes("Bitmap exploded"))).toBe(true);
});

test("when the agent fails, apps falls back to the launcher activities with no icons and says why", async () => {
  fake.override = (command) => {
    if (command === `${AGENT} apps`) throw new Error("hinge-agent: SystemContext unavailable");
    return undefined;
  };
  const result = await catalog().apps(phone());
  expect(result.apps.map((a) => a.pkg)).toEqual(["com.example.chat", "com.example.maps", "com.android.settings", "com.example.notes"]);
  expect(result.apps[0]).toEqual({ pkg: "com.example.chat", label: "com.example.chat", versionCode: null });
  expect(result.icons).toEqual({});
  expect(result.error).toMatch(/SystemContext unavailable/);
  expect(fake.iconCommands()).toEqual([]);
  expect(logs.some((l) => l.includes("SystemContext unavailable"))).toBe(true);
});

test("an agent that never answers times out and falls back like a failure", async () => {
  fake.override = (command) => (command === `${AGENT} apps` ? new Promise<string>(() => {}) : undefined);
  const result = await catalog({ timeoutMs: 20 }).apps(phone());
  expect(result.apps.map((a) => a.pkg)).toContain("com.android.settings");
  expect(result.error).toMatch(/timed out/);
  expect(logs.some((l) => l.includes("timed out"))).toBe(true);
});

test("a timed-out shell call is told to stop", async () => {
  let aborted = false;
  const apps = catalog({
    timeoutMs: 20,
    runShell: (adb, command, signal) => {
      if (command !== `${AGENT} apps`) return fake.runShell(adb, command);
      signal?.addEventListener("abort", () => (aborted = true));
      return new Promise<string>(() => {});
    },
  });
  await apps.apps(phone());
  expect(aborted).toBe(true);
});

test("an icons run that never answers times out and leaves the icons out", async () => {
  fake.override = (command) => (command.startsWith(`${AGENT} icons`) ? new Promise<string>(() => {}) : undefined);
  const result = await catalog({ timeoutMs: 20 }).apps(phone());
  expect(result.apps).toEqual(fake.apps);
  expect(result.icons).toEqual({});
});

test("when the launcher query fails too, apps is empty with the agent's reason", async () => {
  fake.override = (command) => {
    if (command === `${AGENT} apps` || command === LAUNCHER_QUERY) throw new Error("adb went away");
    return undefined;
  };
  const result = await catalog().apps(phone());
  expect(result.apps).toEqual([]);
  expect(result.recents).toEqual([]);
  expect(result.error).toMatch(/adb went away/);
});

test("recents are limited to listed apps and capped at 8", async () => {
  fake.apps = Array.from({ length: 12 }, (_, i) => ({ pkg: `com.example.app${i}`, label: `App ${i}`, versionCode: 1 }));
  fake.recents = Array.from({ length: 12 }, (_, i) => `  * Recent #${i}: Task{${i} #${i} type=standard A=10${i}:com.example.app${11 - i} U=0}\n`).join("")
    + "  * Recent #12: Task{c #12 type=standard A=10114:com.android.systemui U=0}\n";
  const result = await catalog().apps(phone());
  expect(result.recents).toEqual(["com.example.app11", "com.example.app10", "com.example.app9", "com.example.app8", "com.example.app7", "com.example.app6", "com.example.app5", "com.example.app4"]);
});

test("a failed or hung recents dump leaves recents empty", async () => {
  fake.override = (command) => (command === "dumpsys activity recents" ? new Promise<string>(() => {}) : undefined);
  const result = await catalog({ timeoutMs: 20 }).apps(phone());
  expect(result.recents).toEqual([]);
  expect(result.apps).toEqual(fake.apps);
  expect(result.error).toBeNull();
});

test("identify uses the cached label and PNG without asking the phone again", async () => {
  const apps = catalog();
  const p = phone();
  await apps.apps(p);
  fake.commands = [];
  const identity = await apps.identify(p, "com.example.maps");
  expect(identity.label).toBe("Maps");
  expect([...(identity.icon ?? [])]).toEqual([...pngFor("com.example.maps")]);
  expect(fake.commands).toEqual([]);
});

test("identify before any app list fetches the list and the one package's icon", async () => {
  const apps = catalog();
  const identity = await apps.identify(phone(), "com.example.notes");
  expect(identity.label).toBe("Notes");
  expect([...(identity.icon ?? [])]).toEqual([...pngFor("com.example.notes")]);
  expect(fake.iconCommands()).toEqual([`${AGENT} icons 96 com.example.notes`]);
});

test("identify of a package the agent does not list answers with the package name", async () => {
  const identity = await catalog().identify(phone(), "com.example.hidden");
  expect(identity).toEqual({ label: "com.example.hidden", icon: null });
});

test("identify answers with the package name when the agent fails", async () => {
  fake.override = (command) => {
    if (command.startsWith(AGENT)) throw new Error("hinge-agent: nope");
    return undefined;
  };
  expect(await catalog().identify(phone(), "com.example.chat")).toEqual({ label: "com.example.chat", icon: null });
});

async function answers(c: AppCatalog | null, p: ConnectedPhone | null, id = 7): Promise<AppsMessage[]> {
  const sent: AppsMessage[] = [];
  await answerAppsRequest(c, p, id, (msg) => sent.push(msg));
  return sent;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test("with no phone, an apps request says so", async () => {
  const none = { kind: "apps", id: 7, apps: [], recents: [], icons: {}, error: "No phone connected" };
  expect(await answers(catalog(), null)).toEqual([none]);
  expect(await answers(null, phone())).toEqual([none]);
});

test("with a phone and every icon cached, an apps request is answered once with the catalog's apps", async () => {
  const c = catalog();
  await c.apps(phone());
  const sent = await answers(c, phone(), 3);
  expect(sent).toHaveLength(1);
  expect(sent[0].id).toBe(3);
  expect(sent[0].apps).toEqual(fake.apps);
  expect(Object.keys(sent[0].icons)).toHaveLength(3);
  expect(sent[0].error).toBeNull();
});

test("an apps request is answered with the list and cached icons before any icon is fetched, then again with every icon", async () => {
  await cacheIcon("R5CX1234", "com.example.chat", 42);
  let release = (): void => {};
  const gate = new Promise<void>((r) => (release = r));
  fake.override = async (command) => {
    if (!command.startsWith(`${AGENT} icons`)) return undefined;
    await gate;
    return undefined;
  };
  const sent: AppsMessage[] = [];
  const done = answerAppsRequest(catalog(), phone(), 5, (msg) => sent.push(msg));
  await vi.waitFor(() => expect(fake.iconCommands()).toHaveLength(1));
  await flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ kind: "apps", id: 5, apps: fake.apps, recents: ["com.example.chat", "com.example.maps", "com.example.notes"], error: null });
  expect(Object.keys(sent[0].icons)).toEqual(["com.example.chat"]);

  fake.override = null;
  release();
  await done;
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ kind: "apps", id: 5, apps: fake.apps, error: null });
  expect(Object.keys(sent[1].icons).sort()).toEqual(["com.example.chat", "com.example.maps", "com.example.notes"]);
});

test("an apps request whose listing throws still gets an answer", async () => {
  const broken = { apps: async () => { throw new Error("disk on fire"); } } as unknown as AppCatalog;
  expect(await answers(broken, phone())).toEqual([{ kind: "apps", id: 7, apps: [], recents: [], icons: {}, error: "Could not list the phone's apps: disk on fire" }]);
});

test("a package the agent names with path or shell characters never reaches the icons command or the cache", async () => {
  fake.apps = [
    { pkg: "../../../../Desktop/x", label: "Evil", versionCode: 1 },
    { pkg: "a;reboot", label: "Evil", versionCode: 1 },
    { pkg: "com.example.chat", label: "Chat", versionCode: 42 },
  ];
  const result = await catalog().apps(phone());
  expect(result.apps.map((a) => a.pkg)).toEqual(["com.example.chat"]);
  expect(fake.iconCommands()).toEqual([`${AGENT} icons 96 com.example.chat`]);
});

test.each(["..", "...", ""])("an identity of %j caches no icon outside the cache folder but still shows the icons", async (deviceId) => {
  const root = await mkdtemp(join(tmpdir(), "hinge-root-"));
  const nested = join(root, "icons");
  const result = await catalog({ cacheDir: nested }).apps(phone(deviceId));
  expect(Object.keys(result.icons)).toHaveLength(3);
  const written = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".png"));
  expect(written).toEqual([]);
});

test("a cache file that cannot be written is logged and the other icons are still cached", async () => {
  await mkdir(join(cacheDir, "R5CX1234", "com.example.chat@42.png"), { recursive: true });
  const result = await catalog().apps(phone());
  expect(Object.keys(result.icons).sort()).toEqual(["com.example.chat", "com.example.maps", "com.example.notes"]);
  expect([...(await readFile(join(cacheDir, "R5CX1234", "com.example.notes@3.png")))]).toEqual([...pngFor("com.example.notes")]);
  expect(logs.some((l) => l.includes("com.example.chat"))).toBe(true);
});
