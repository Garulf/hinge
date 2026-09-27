import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = "com.example.chat";

const softwareGl = process.env.HINGE_E2E_REAL_GPU !== "1";

async function launch(recording: string, extra: string[]): Promise<ElectronApplication> {
  const userData = await mkdtemp(join(tmpdir(), "hinge-e2e-"));
  const args = ["--replay", recording, "--user-data", userData, ...extra, ...(softwareGl ? ["--use-gl=angle", "--use-angle=swiftshader"] : []), "--no-sandbox"];
  const executablePath = process.env.HINGE_E2E_EXECUTABLE;
  return electron.launch(executablePath ? { executablePath, args } : { args: [resolve("out/main/index.js"), ...args] });
}

async function windowTitled(app: ElectronApplication, title: string, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      const win = await app.browserWindow(page);
      if ((await win.evaluate((w) => w.getTitle())) === title) return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no window titled ${title} within ${timeoutMs} ms`);
}

interface PopoutReading {
  framesDecoded: number;
  videoSize: { w: number; h: number } | null;
  viewport: { width: number; height: number; dpr: number };
}

function reading(page: Page): Promise<PopoutReading | null> {
  return page.evaluate(() => {
    const api = (window as unknown as { __hingePopout?: PopoutReading }).__hingePopout;
    return api ? { framesDecoded: api.framesDecoded, videoSize: api.videoSize, viewport: api.viewport } : null;
  });
}

test("a pop-out app window streams from the replay, resizes its display and quits hinge when closed", async () => {
  const app = await launch("test/fixtures/synthetic-fold.hrec", ["--app", PKG]);
  const quit = app.waitForEvent("close", { timeout: 60_000 });

  const page = await windowTitled(app, PKG, 20_000);
  await expect.poll(async () => (await reading(page))?.framesDecoded ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  const mainShown = await app.evaluate(({ BrowserWindow }, pkg) => BrowserWindow.getAllWindows().some((w) => w.getTitle() !== pkg && w.isVisible()), PKG);
  expect(mainShown, "the main window stays hidden with --app").toBe(false);

  const dpr = await page.evaluate(() => devicePixelRatio);
  await app.evaluate(({ BrowserWindow }, pkg) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === pkg)!.setContentSize(520, 900), PKG);
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __hingePopoutResizes?: unknown[] }).__hingePopoutResizes ?? []), { timeout: 10_000 })
    .toEqual([{ width: 520, height: 896, dpi: 160 * dpr }]);

  await app.evaluate(({ BrowserWindow }, pkg) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === pkg)!.close(), PKG);
  await quit;
});

test("the Apps button opens the picker, which asks main for the phone's apps and says why there are none", async () => {
  test.setTimeout(120_000);
  const app = await launch("test/fixtures/synthetic-fold.hrec", []);
  try {
    const page = await app.firstWindow();
    const picker = page.getByRole("dialog", { name: "Apps" });
    // The replay opens and rotates the phone, moving the menu out from under the pointer, so hover and click are retried until one lands.
    const openPicker = async () => {
      await page.mouse.move((await page.evaluate(() => innerWidth)) / 2, 8);
      await page.locator('[data-button="apps"]').click({ timeout: 2000 }).catch(() => {});
      return picker.isVisible();
    };
    await expect.poll(openPicker, { timeout: 60_000, intervals: [500] }).toBe(true);
    await expect(picker.getByRole("textbox", { name: "Search apps" })).toBeFocused();
    await expect(picker.locator("[data-picker-error]")).toHaveText("No phone connected", { timeout: 10_000 });
    await expect(picker).not.toHaveAttribute("aria-busy", "true");
  } finally {
    await app.close();
  }
});
