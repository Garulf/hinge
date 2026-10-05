import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FOLD7_BODY } from "../../src/shared/layout";

type Lit = "cover" | "inner" | null;

interface Stats {
  framesDecoded: number;
  cls: { screen: string; rotated: boolean } | null;
  window: { w: number; h: number };
  angle: number | null;
  lit: Lit;
  rotation: number;
  badge: "flex" | null;
  settled: boolean;
  brightness: { cover: number; inner: number };
  view: { t: number; active: boolean };
  modelRotation: { yaw: number; pitch: number };
  scaling?: boolean;
  laidOut: boolean;
}

interface Phase {
  atMs: number;
  lit: Lit;
  moving: boolean;
  settled: boolean;
  rotation: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CLOSED_ASPECT = FOLD7_BODY.closedWidthMm / FOLD7_BODY.heightMm;
const OPEN_ASPECT = FOLD7_BODY.openWidthMm / FOLD7_BODY.heightMm;

// HINGE_E2E_REAL_GPU skips the SwiftShader flags so the app renders on the
// host's actual GPU instead of software GL; scripts/e2e-remote.sh sets it.
const softwareGl = process.env.HINGE_E2E_REAL_GPU !== "1";

async function launch(recording: string, extra: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  // A fresh settings folder per run, so a colourway picked here never leaks into the next run or the user's own settings.
  const userData = await mkdtemp(join(tmpdir(), "hinge-e2e-"));
  const args = ["--replay", recording, "--user-data", userData, ...extra, ...(softwareGl ? ["--use-gl=angle", "--use-angle=swiftshader"] : []), "--no-sandbox"];
  // Defaults to running the unpacked main entry through the electron npm binary;
  // set HINGE_E2E_EXECUTABLE to a packaged build's executable to run against it instead.
  const executablePath = process.env.HINGE_E2E_EXECUTABLE;
  const app = await electron.launch(executablePath ? { executablePath, args } : { args: [resolve("out/main/index.js"), ...args] });
  return { app, page: await app.firstWindow() };
}

/**
 * __hinge is assigned at the end of the renderer's module script, which can
 * still be mid-execution right after firstWindow() resolves, so an empty
 * reading stands in until it exists. laidOut is false while the window has
 * resized but the scene has not yet re-laid out for it (seconds on a
 * software GL), when a screenshot would show the old frame in a corner.
 */
function stats(page: Page): Promise<Stats> {
  return page.evaluate(() => {
    const api = (window as unknown as { __hinge?: { stats(): Omit<Stats, "laidOut"> } }).__hinge;
    const canvas = document.querySelector("canvas");
    const laidOut = canvas !== null && canvas.width === Math.round(innerWidth * devicePixelRatio) && canvas.height === Math.round(innerHeight * devicePixelRatio);
    if (!api) {
      return {
        framesDecoded: 0,
        cls: null,
        window: { w: 0, h: 0 },
        angle: null,
        lit: null,
        rotation: 0,
        badge: null,
        settled: false,
        brightness: { cover: 0, inner: 0 },
        view: { t: 0, active: false },
        modelRotation: { yaw: 0, pitch: 0 },
        laidOut,
      };
    }
    return { ...api.stats(), laidOut };
  });
}

function phases(page: Page): Promise<Phase[]> {
  return page.evaluate(() => (window as unknown as { __hinge: { phases(): Phase[] } }).__hinge.phases());
}

function windowBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
}

async function waitFor(page: Page, what: string, matches: (s: Stats) => boolean, timeoutMs: number): Promise<Stats> {
  const deadline = Date.now() + timeoutMs;
  let last: Stats | null = null;
  while (Date.now() < deadline) {
    last = await stats(page);
    if (matches(last)) return last;
  }
  throw new Error(`timed out waiting for ${what}; last reading ${JSON.stringify(last)}`);
}

/** Settled on the lit screen at full brightness with the canvas laid out for the final window size. */
function restingOn(lit: "cover" | "inner", s: Stats): boolean {
  return s.lit === lit && s.settled && s.laidOut && s.brightness[lit] === 1;
}

/** Animation frame intervals over a stretch of playback, to show what uploading and mipmapping every video frame costs. */
async function frameIntervals(page: Page, durationMs: number): Promise<{ median: number; p95: number; max: number; frames: number }> {
  const intervals = await page.evaluate(
    (durationMs) =>
      new Promise<number[]>((resolve) => {
        const gaps: number[] = [];
        let last: number | null = null;
        const start = performance.now();
        const tick = (now: number) => {
          if (last !== null) gaps.push(now - last);
          last = now;
          if (now - start < durationMs) requestAnimationFrame(tick);
          else resolve(gaps);
        };
        requestAnimationFrame(tick);
      }),
    durationMs,
  );
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0, frames: sorted.length };
}

/** MOD+d: turns the phone back to straight on. */
async function center(page: Page): Promise<void> {
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyD");
  await page.keyboard.up("Alt");
}

type Press = "touch" | "turn" | "move";

function pressAt(page: Page, x: number, y: number): Promise<Press> {
  return page.evaluate(([x, y]) => (window as unknown as { __hinge: { pressAt(x: number, y: number): Press } }).__hinge.pressAt(x, y), [x, y]);
}

/**
 * A point on the left side of the case at height `y`, found by walking in
 * from the window's left edge past any room around a turned phone: halfway
 * across the bezel beside a lit screen, or a few pixels in when nothing is
 * lit there.
 */
async function sideOfCase(page: Page, y: number): Promise<{ x: number; y: number }> {
  let start = 0;
  while (start < 400 && (await pressAt(page, start, y)) === "move") start++;
  let end = start;
  while (end < start + 12 && (await pressAt(page, end, y)) === "turn") end++;
  const x = start + Math.min((end - start) / 2, 6);
  expect(await pressAt(page, x, y), `the side of the case at ${x}, ${y}`).toBe("turn");
  return { x, y };
}

/**
 * A turn lands in one step, and the window grows around it over the next
 * few frames: laid out, at the same size a few frames apart.
 */
async function windowAtRest(page: Page): Promise<Stats> {
  const deadline = Date.now() + 10_000;
  let previous = await waitFor(page, "the window laid out", (s) => s.laidOut, 10_000);
  while (Date.now() < deadline) {
    await frames(page, 3);
    const s = await waitFor(page, "the window laid out", (s) => s.laidOut, 10_000);
    if (s.window.w === previous.window.w && s.window.h === previous.window.h) return s;
    previous = s;
  }
  throw new Error(`the window kept resizing; last ${JSON.stringify(previous.window)}`);
}

/** Puts the pointer on a point of the screen, wherever the window has moved to under it, as a real mouse would be. */
async function moveOnScreen(app: ElectronApplication, page: Page, point: { x: number; y: number }): Promise<void> {
  const origin = await windowBounds(app);
  await page.mouse.move(point.x - origin.x, point.y - origin.y);
}

/**
 * A plain left drag from a point in the window, by a distance travelled on
 * the screen, which turns the phone from a side or corner of the case: the
 * window grows and moves around the turning phone meanwhile.
 */
async function drag(app: ElectronApplication, page: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  const origin = await windowBounds(app);
  const start = { x: origin.x + from.x, y: origin.y + from.y };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 5;
  for (let i = 1; i <= steps; i++) await moveOnScreen(app, page, { x: start.x + (by.x * i) / steps, y: start.y + (by.y * i) / steps });
  await page.mouse.up();
}

/** Fraction of pixels in which any channel differs by more than `tolerance` (a compression step by default) between two same-size screenshots. */
async function differingPixels(page: Page, a: Buffer, b: Buffer, tolerance = 16): Promise<number> {
  return page.evaluate(
    async ({ a, b, tolerance }) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = await Promise.all([decode(a), decode(b)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      let differing = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        if ([0, 1, 2, 3].some((c) => Math.abs(x.data[i + c] - y.data[i + c]) > tolerance)) differing++;
      }
      return differing / (x.width * x.height);
    },
    { a: a.toString("base64"), b: b.toString("base64"), tolerance },
  );
}

function aspect(s: Stats): number {
  return s.window.h > 0 ? s.window.w / s.window.h : 0;
}

/**
 * Fraction of rows in which the crease column differs from the average of
 * the columns a few pixels either side by more than a colour step could
 * explain; a seam darkens or lightens nearly every row, while the test
 * pattern's moving shapes cross the crease in only a few.
 */
async function creaseSeamRows(page: Page, png: Buffer, creaseX: number, top: number, bottom: number): Promise<number> {
  return page.evaluate(
    async ({ base64, creaseX, top, bottom }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / innerWidth;
      const x = Math.round(creaseX * scale);
      const span = Math.round(4 * scale);
      const band = ctx.getImageData(x - span, 0, 2 * span + 1, bitmap.height);
      const pixel = (px: number, py: number) => {
        const i = (py * band.width + (px - x + span)) * 4;
        return band.data.subarray(i, i + 4);
      };
      let seamRows = 0;
      let rows = 0;
      for (let y = Math.round(top * scale); y < Math.round(bottom * scale); y++) {
        const left = pixel(x - span, y);
        const right = pixel(x + span, y);
        const neighboursAgree = [0, 1, 2].every((c) => Math.abs(left[c] - right[c]) < 24);
        if (!neighboursAgree) continue;
        rows++;
        for (let dx = -1; dx <= 1; dx++) {
          const centre = pixel(x + dx, y);
          if ([0, 1, 2].some((c) => Math.abs(centre[c] - (left[c] + right[c]) / 2) > 24)) {
            seamRows++;
            break;
          }
        }
      }
      return rows > 0 ? seamRows / rows : 1;
    },
    { base64: png.toString("base64"), creaseX, top, bottom },
  );
}

test("replays the synthetic fold: closed, opening led by posture, open, landscape", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch(resolve("test/fixtures/synthetic-fold.hrec"));
  try {
    const closed = await waitFor(page, "the closed phone", (s) => restingOn("cover", s) && s.framesDecoded > 10 && Math.abs(aspect(s) - CLOSED_ASPECT) < 0.02, 30_000);
    expect(closed.angle).toBe(0);
    expect(closed.cls).toEqual({ screen: "cover", rotated: false });
    const closedBounds = await windowBounds(app);
    await page.screenshot({ path: "test-results/closed.png" });

    // The fixture holds HALF_OPENED with the inner screen lit for 2 s before
    // opening flat. A software GL can draw too few frames in that window to
    // rest first, so only a real GPU waits for the settled pose to shoot it.
    const flex = await waitFor(page, "the flex badge", (s) => s.badge === "flex" && s.lit === "inner" && (softwareGl || (restingOn("inner", s) && s.rotation === 0)), 20_000);
    expect(flex.badge).toBe("flex");
    await page.screenshot({ path: "test-results/flex.png" });

    const open = await waitFor(page, "the open phone", (s) => restingOn("inner", s) && s.badge === null && s.rotation === 0 && Math.abs(aspect(s) - OPEN_ASPECT) < 0.02, 20_000);
    expect(open.angle).toBe(180);
    const openBounds = await windowBounds(app);
    expect(Math.abs(openBounds.x + openBounds.width - (closedBounds.x + closedBounds.width))).toBeLessThanOrEqual(2);
    const openShot = await page.screenshot({ path: "test-results/open.png" });

    // The case's top and bottom move the window, its sides and corners turn
    // the phone, and the lit screen between them is the phone's.
    const middle = open.window.h / 2;
    const side = await sideOfCase(page, middle);
    expect(side.x).toBeGreaterThan(1);
    expect(await pressAt(page, open.window.w - side.x, middle)).toBe("turn");
    expect(await pressAt(page, open.window.w / 2, middle)).toBe("touch");
    expect(await pressAt(page, open.window.w * 0.3, 2)).toBe("move");
    expect(await pressAt(page, open.window.w * 0.7, open.window.h - 2)).toBe("move");
    for (const [x, y] of [
      [2, 2],
      [open.window.w - 2, 2],
      [2, open.window.h - 2],
      [open.window.w - 2, open.window.h - 2],
    ]) {
      expect(await pressAt(page, x, y), `the corner at ${x}, ${y}`).toBe("turn");
    }

    // Center while straight on changes nothing.
    await center(page);
    await frames(page, 3);
    await waitFor(page, "the open phone after Center", (s) => restingOn("inner", s) && !s.view.active && s.view.t === 0, 20_000);
    expect(await windowBounds(app)).toEqual(openBounds);
    const workAgainShot = await page.screenshot({ path: "test-results/open-after-center.png" });
    expect(await differingPixels(page, openShot, workAgainShot)).toBeLessThan(0.005);

    // Posture leads the inner stream by 300 ms, less than a software GL's
    // gap between animation frames, so only a real GPU draws the cover
    // moving before the handoff.
    if (!softwareGl) {
      const history = await phases(page);
      const firstInner = history.findIndex((p) => p.lit === "inner");
      expect(firstInner).toBeGreaterThan(0);
      expect(history.slice(0, firstInner).some((p) => p.lit === "cover" && p.moving)).toBe(true);
    }

    if (!softwareGl) {
      const timing = await frameIntervals(page, 2000);
      await writeFile("test-results/frame-times.json", JSON.stringify(timing, null, 2));
      expect(timing.median).toBeLessThan(34);
    }

    const pxPerMm = open.window.h / FOLD7_BODY.heightMm;
    const creaseX = open.window.w - FOLD7_BODY.closedWidthMm * pxPerMm;
    const screenTop = 0.1 * open.window.h;
    const screenBottom = 0.9 * open.window.h;
    await page.screenshot({
      path: "test-results/open-crease.png",
      clip: { x: Math.round(creaseX) - 20, y: Math.round(screenTop), width: 40, height: 120 },
    });
    expect(await creaseSeamRows(page, openShot, creaseX, screenTop, screenBottom)).toBeLessThan(0.1);

    const landscape = await waitFor(page, "the landscape phone", (s) => restingOn("inner", s) && s.rotation === 1 && s.cls?.rotated === true && s.window.w > s.window.h, 45_000);
    expect(aspect(landscape)).toBeCloseTo(1 / OPEN_ASPECT, 1);
    expect(landscape.angle).toBe(180);
    await page.screenshot({ path: "test-results/landscape.png" });
  } finally {
    await app.close();
  }
});

/** A settled phase on one screen after a settled phase on the other: a completed fold, not a rotation on the same screen. */
function settledTransition(history: Phase[], from: "cover" | "inner", to: "cover" | "inner"): boolean {
  let sawFrom = false;
  for (const p of history) {
    if (p.lit === from && p.settled) sawFrom = true;
    else if (sawFrom && p.lit === to && p.settled && !p.moving) return true;
  }
  return false;
}

const realRecording = process.env.HINGE_REAL_RECORDING;

test("replays a real recording through at least one open and one close", async () => {
  test.skip(!realRecording, "set HINGE_REAL_RECORDING to a --record capture to run this");
  const timeoutMs = Number(process.env.HINGE_REAL_RECORDING_TIMEOUT_MS ?? 180_000);
  test.setTimeout(timeoutMs + 30_000);
  const { app, page } = await launch(resolve(realRecording!));
  try {
    await waitFor(page, "the renderer", (s) => s.framesDecoded > 0, 30_000);
    const deadline = Date.now() + timeoutMs;
    const seen = new Map<number, Phase>();
    let history: Phase[] = [];
    while (Date.now() < deadline) {
      for (const p of await phases(page)) seen.set(p.atMs, p);
      history = [...seen.values()].sort((a, b) => a.atMs - b.atMs);
      if (settledTransition(history, "cover", "inner") && settledTransition(history, "inner", "cover")) break;
      await page.waitForTimeout(250);
    }
    expect(settledTransition(history, "cover", "inner")).toBe(true);
    expect(settledTransition(history, "inner", "cover")).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * Mean sRGB brightness (0..255) of the phone's outer rim: the first few
 * opaque pixels in from the left and right edges on the middle rows, which
 * is the frame, whatever the screen is showing.
 */
async function rimBrightness(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const depth = Math.max(2, Math.round(width / 300));
    let sum = 0;
    let count = 0;
    for (let y = Math.round(height * 0.2); y < Math.round(height * 0.8); y++) {
      for (const direction of [1, -1]) {
        let x = direction > 0 ? 0 : width - 1;
        while (x >= 0 && x < width && data[(y * width + x) * 4 + 3] < 200) x += direction;
        for (let d = 0; d < depth && x >= 0 && x < width; d++, x += direction) {
          const i = (y * width + x) * 4;
          sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
          count++;
        }
      }
    }
    return count > 0 ? sum / count : 0;
  }, png.toString("base64"));
}

/**
 * Every toast text shown since this was called: a toast lives three seconds
 * from when it arrives, which on a software GL can pass in a few animation
 * frames, so polling for it could miss it.
 */
async function watchToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { __toasts: Set<string> }).__toasts = seen;
    const record = () => document.querySelectorAll(".hinge-toast").forEach((n) => seen.add(n.textContent ?? ""));
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

async function waitForToast(page: Page, matches: (text: string) => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = await page.evaluate(() => [...(window as unknown as { __toasts: Set<string> }).__toasts]);
    if (seen.some(matches)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`no toast ${what}; saw ${JSON.stringify(seen)}`);
}

test("hover menu on the top edge, transfer toasts for a drop, and a colourway change", async () => {
  test.setTimeout(150_000);
  const dir = await mkdtemp(join(tmpdir(), "hinge-drop-"));
  const apk = join(dir, "My App.apk");
  const photo = join(dir, "café photo.jpg");
  await writeFile(apk, new Uint8Array(24 * 1024 * 1024));
  await writeFile(photo, new Uint8Array(50_000));

  const { app, page } = await launch(resolve("test/fixtures/synthetic-fold.hrec"), ["--dry-run-transfers"]);
  try {
    const closed = await waitFor(page, "the closed phone", (s) => restingOn("cover", s) && s.framesDecoded > 10, 30_000);
    const menu = page.locator("[data-menu]");
    await expect(menu).not.toHaveClass(/shown/);
    await page.mouse.move(closed.window.w / 2, 8);
    await expect(menu).toHaveClass(/shown/, { timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/hover-menu.png" });
    await page.mouse.move(closed.window.w / 2, closed.window.h / 2);
    await expect(menu).not.toHaveClass(/shown/, { timeout: 5000 });

    await watchToasts(page);
    await page.evaluate((paths) => (window as unknown as { __hinge: { drop(p: string[]): void } }).__hinge.drop(paths), [photo, apk]);
    await waitForToast(page, (t) => t === "Sent café photo.jpg to Download", "for the pushed photo", 15_000);
    await waitForToast(page, (t) => /^Installing My App\.apk \d+%$/.test(t), "with the install's progress", 15_000);
    await page.screenshot({ path: "test-results/toasts.png" });
    await waitForToast(page, (t) => t === "Installed My App.apk", "for the finished install", 30_000);

    await waitFor(page, "the replay to end", (s) => s.lit === null && s.settled && s.laidOut && s.brightness.inner === 0 && s.brightness.cover === 0 && s.angle === 180 && s.window.w > s.window.h, 60_000);
    await page.mouse.move(10, 300);
    await page.waitForTimeout(1000);
    const before = await rimBrightness(page, await page.screenshot({ path: "test-results/colour-before.png" }));

    const s = await stats(page);
    await page.mouse.move(s.window.w / 2, 8);
    await expect(menu).toHaveClass(/shown/, { timeout: 5000 });
    await page.locator('[data-button="colour"]').click();
    await page.locator('[data-colourway="silver-shadow"]').click();
    await expect(page.locator('[data-colourway="silver-shadow"]')).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: "test-results/colour-panel.png" });
    await page.locator('[data-button="settings"]').click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.screenshot({ path: "test-results/settings-panel.png" });
    await page.locator('[data-button="device"]').click();
    await expect(page.getByRole("dialog", { name: "Devices" }).getByText("No devices")).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: "test-results/device-panel.png" });
    const devices = page.getByRole("dialog", { name: "Devices" });
    const status = devices.locator("[data-device-status]");
    await devices.getByPlaceholder("192.168.1.20:37099").fill("192.168.1.20:37099");
    await devices.getByPlaceholder("123456").fill("12");
    await devices.getByRole("button", { name: "Pair" }).click();
    await expect(status).toHaveText(/6 digits/);
    await devices.getByPlaceholder("123456").fill("123456");
    await devices.getByRole("button", { name: "Pair" }).click();
    await expect(status).toHaveText("Pairing failed: no phone connection in this mode", { timeout: 10_000 });
    await expect(status).toHaveClass(/error/);
    await page.screenshot({ path: "test-results/device-panel-error.png" });
    await page.keyboard.press("Escape");
    await page.mouse.move(10, s.window.h / 2);
    await page.waitForTimeout(1500);
    const after = await rimBrightness(page, await page.screenshot({ path: "test-results/colour-after.png" }));
    await writeFile("test-results/colour-rim.json", JSON.stringify({ before, after }, null, 2));
    expect(after - before).toBeGreaterThan(40);

    const pxPerMm = (s: Stats) => (s as Stats & { pxPerMm: number }).pxPerMm;
    const unscaled = await stats(page);
    await page.mouse.move(unscaled.window.w / 2, unscaled.window.h / 2);
    await page.keyboard.down("Alt");
    await page.mouse.wheel(0, 100);
    await page.keyboard.up("Alt");
    await waitFor(page, "the phone to shrink a step", (s) => s.settled && !s.scaling && pxPerMm(s) < pxPerMm(unscaled), 20_000);
    const smaller = await windowAtRest(page);
    expect(pxPerMm(smaller) / pxPerMm(unscaled)).toBeCloseTo(0.9, 2);
    expect(smaller.window.w / unscaled.window.w).toBeCloseTo(0.9, 1);

    const frame = await sideOfCase(page, smaller.window.h / 2);
    await page.mouse.move(frame.x, frame.y);
    await page.mouse.wheel(0, -100);
    await waitFor(page, "the wheel on the frame to grow the phone a step", (s) => s.settled && !s.scaling && pxPerMm(s) > pxPerMm(smaller), 20_000);
    const regrown = await windowAtRest(page);
    expect(regrown.window.w).toBeCloseTo(unscaled.window.w, -1);
    expect(pxPerMm(regrown) / pxPerMm(unscaled)).toBeCloseTo(1, 2);

    await page.mouse.move(10, regrown.window.h / 2);
    await expect(menu).not.toHaveClass(/shown/, { timeout: 5000 });
    await drag(app, page, await sideOfCase(page, regrown.window.h / 2), { x: 100, y: 0 });
    await waitFor(page, "the turned phone", (s) => s.view.t === 1 && s.window.w * s.window.h > regrown.window.w * regrown.window.h, 20_000);
    const turned = await windowAtRest(page);
    await page.mouse.move(turned.window.w / 2, 8);
    await expect(menu).toHaveClass(/shown/, { timeout: 5000 });
    const box = (await menu.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - turned.window.w / 2)).toBeLessThanOrEqual(2);
    expect(box.y).toBeLessThan(24);
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/turned-menu.png" });
  } finally {
    await app.close();
  }
});

/** The bounding box, in CSS px, of the phone's opaque pixels. */
async function opaqueBox(page: Page, png: Buffer): Promise<{ x: number; y: number; w: number; h: number }> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] < 200) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const scale = bitmap.width / innerWidth;
    return { x: minX / scale, y: minY / scale, w: (maxX - minX + 1) / scale, h: (maxY - minY + 1) / scale };
  }, png.toString("base64"));
}

/**
 * The fraction of each outermost row and column of the window that is
 * opaque: a phone cut off by the window's edge runs along it, while one
 * inside it touches the edge at a corner at most.
 */
async function edgeCoverage(page: Page, png: Buffer): Promise<{ top: number; bottom: number; left: number; right: number }> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const opaque = (x: number, y: number) => data[(y * width + x) * 4 + 3] >= 200;
    const row = (y: number) => Array.from({ length: width }, (_, x) => opaque(x, y)).filter(Boolean).length / width;
    const column = (x: number) => Array.from({ length: height }, (_, y) => opaque(x, y)).filter(Boolean).length / height;
    return { top: row(0), bottom: row(height - 1), left: column(0), right: column(width - 1) };
  }, png.toString("base64"));
}

async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );
}

function streamPointAt(page: Page, x: number, y: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(([x, y]) => (window as unknown as { __hinge: { streamPointAt(x: number, y: number): { x: number; y: number } | null } }).__hinge.streamPointAt(x, y), [x, y]);
}

/** The same drag with Alt held, which turns the phone from anywhere on it. */
async function altDrag(app: ElectronApplication, page: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  await page.keyboard.down("Alt");
  await drag(app, page, from, by);
  await page.keyboard.up("Alt");
}

async function altDoubleClick(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.keyboard.down("Alt");
  await page.mouse.dblclick(at.x, at.y);
  await page.keyboard.up("Alt");
}

interface TurnStats extends Stats {
  pxPerMm: number;
  turn: { centre: { x: number; y: number; z: number }; box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } };
}

/** The leftmost client x on the row through `from` that touches the stream, found by halving between the window's edge and `from`. */
async function leftEdgeOfScreen(page: Page, from: { x: number; y: number }): Promise<number> {
  let off = 0;
  let on = from.x;
  while (on - off > 0.5) {
    const x = (off + on) / 2;
    if (await streamPointAt(page, x, from.y)) on = x;
    else off = x;
  }
  return on;
}

function turnedTo(yaw: number, pitch: number): (s: Stats) => boolean {
  return (s) => Math.abs(s.modelRotation.yaw - yaw) < 1e-9 && Math.abs(s.modelRotation.pitch - pitch) < 1e-9;
}

test("dragging a side of the case turns the phone into the 3D look, and Center brings back the exact work view", async () => {
  test.setTimeout(180_000);
  const { app, page } = await launch(resolve("test/fixtures/synthetic-fold.hrec"));
  try {
    const open = await waitFor(page, "the open phone", (s) => restingOn("inner", s) && s.badge === null && s.rotation === 0 && Math.abs(aspect(s) - OPEN_ASPECT) < 0.02, 45_000);
    const mid = { x: open.window.w / 2, y: open.window.h / 2 };
    const centreHit = (await streamPointAt(page, mid.x, mid.y))!;
    expect(centreHit).not.toBeNull();
    // The work view is orthographic at a known scale, so two probes a known
    // distance apart give the screen's width; the pose box at rest gives how
    // far the screen stands in front of the turn's centre.
    const probePx = 100;
    const [probeLeft, probeRight] = await Promise.all([streamPointAt(page, mid.x - probePx, mid.y), streamPointAt(page, mid.x + probePx, mid.y)]);
    const screenWidthM = (2 * probePx) / ((open as TurnStats).pxPerMm * 1000) / (probeRight!.x - probeLeft!.x);
    const restTurn = (open as TurnStats).turn;
    const screenDepthM = restTurn.box.max.z - restTurn.centre.z;

    // Turning the live, streaming phone by the side of its case: 30 degrees is the full 3D look.
    await drag(app, page, await sideOfCase(page, mid.y), { x: 100, y: 0 });
    await waitFor(page, "the live phone turned", (s) => turnedTo(30, 0)(s) && s.view.t === 1 && !s.view.active, 10_000);
    const liveTurned = await windowAtRest(page);
    await page.screenshot({ path: "test-results/turn-live.png" });
    // The window has grown evenly around the turned phone, so its own centre
    // is where the camera looks: the work view's centre, which for the
    // settled open phone is the turn's centre to within the body's 0.3 mm
    // modelling tolerance. That ray passes through the pivot and meets the
    // screen, standing screenDepthM in front of it, screenDepthM * tan 30
    // degrees to the left of the stream point the work view's centre touched.
    // Measured on a real GPU the prediction is within 0.0002 of the hit;
    // 0.002 allows for the glass sitting up to half a millimetre below the
    // body's front face.
    const turnedMid = { x: liveTurned.window.w / 2, y: liveTurned.window.h / 2 };
    const turnedHit = await streamPointAt(page, turnedMid.x, turnedMid.y);
    expect(turnedHit).not.toBeNull();
    const parallax = (screenDepthM * Math.tan((30 * Math.PI) / 180)) / screenWidthM;
    expect(Math.abs(turnedHit!.x - (centreHit.x - parallax))).toBeLessThan(0.002);
    expect(Math.abs(turnedHit!.y - centreHit.y)).toBeLessThan(0.002);
    // The turn stays where it was left; there is no ease back on its own.
    await page.waitForTimeout(2500);
    expect((await stats(page)).modelRotation).toEqual({ yaw: 30, pitch: 0 });
    await center(page);
    // The window gives back the turn's room once the phone is straight on.
    await waitFor(page, "the phone straight on again, room given back", (s) => turnedTo(0, 0)(s) && s.view.t === 0 && !s.view.active && s.laidOut && s.window.w * s.window.h < liveTurned.window.w * liveTurned.window.h, 10_000);
    const straight = await windowAtRest(page);
    const restMid = { x: straight.window.w / 2, y: straight.window.h / 2 };

    // Alt+drag still turns from anywhere, the screen included: a touch just
    // inside the resting screen's left edge misses the screen once it is
    // turned edge-in, and Alt+double-click centres it.
    const insideLeftEdge = (await leftEdgeOfScreen(page, restMid)) + 4;
    expect(await streamPointAt(page, insideLeftEdge, restMid.y)).not.toBeNull();
    const restOrigin = await windowBounds(app);
    await altDrag(app, page, restMid, { x: 100, y: 0 });
    await waitFor(page, "the phone turned by Alt+drag", turnedTo(30, 0), 10_000);
    await windowAtRest(page);
    const turnedOrigin = await windowBounds(app);
    const [grownX, grownY] = [restOrigin.x - turnedOrigin.x, restOrigin.y - turnedOrigin.y];
    expect(await streamPointAt(page, insideLeftEdge + grownX, restMid.y + grownY)).toBeNull();
    await altDoubleClick(page, { x: restMid.x + grownX, y: restMid.y + grownY });
    await waitFor(page, "the turn back at rest", (s) => turnedTo(0, 0)(s) && s.view.t === 0, 10_000);

    const ended = await waitFor(
      page,
      "the replay to end",
      (s) => s.lit === null && s.settled && s.laidOut && s.brightness.inner === 0 && s.brightness.cover === 0 && s.angle === 180 && s.window.w > s.window.h,
      60_000,
    );
    const centre = { x: ended.window.w / 2, y: ended.window.h / 2 };
    const endedBounds = await windowBounds(app);
    await page.mouse.move(centre.x, centre.y);
    await frames(page, 3);
    const workRest = await page.screenshot({ path: "test-results/turn-work-rest.png" });

    const side = await sideOfCase(page, centre.y);
    await drag(app, page, side, { x: 80, y: -40 });
    await waitFor(page, "the phone turned", turnedTo(24, 12), 10_000);
    const turned = await windowAtRest(page);
    // The window grows evenly around the phone for the turn, which stays where it was on screen.
    const turnedBounds = await windowBounds(app);
    expect(turned.window.w * turned.window.h).toBeGreaterThan(ended.window.w * ended.window.h);
    expect(Math.abs(turnedBounds.x + turnedBounds.width / 2 - (endedBounds.x + endedBounds.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(turnedBounds.y + turnedBounds.height / 2 - (endedBounds.y + endedBounds.height / 2))).toBeLessThanOrEqual(1);
    await frames(page, 3);
    const shotTurned = await page.screenshot({ path: "test-results/turn-turned.png" });
    const restBox = await opaqueBox(page, workRest);
    const turnedBox = await opaqueBox(page, shotTurned);
    const turnedEdges = await edgeCoverage(page, shotTurned);
    await writeFile("test-results/turn-boxes.json", JSON.stringify({ restBox, turnedBox, turnedEdges }, null, 2));
    expect(turnedBox.w).toBeLessThan(restBox.w * 0.95);
    for (const side of ["top", "bottom", "left", "right"] as const) expect(turnedEdges[side], `phone cut off at the ${side}`).toBeLessThan(0.03);

    // A double-click on the side of the (turned) case centres it, and straight on is the work view to the pixel.
    const turnedSide = await sideOfCase(page, turned.window.h / 2);
    await page.mouse.dblclick(turnedSide.x, turnedSide.y);
    await waitFor(page, "the phone centred by a double-click", (s) => turnedTo(0, 0)(s) && s.view.t === 0 && !s.view.active && s.settled && s.laidOut && s.window.w === ended.window.w && s.window.h === ended.window.h, 10_000);
    await frames(page, 3);
    const doubleClickBack = await page.screenshot({ path: "test-results/turn-double-click-reset.png" });
    expect(await differingPixels(page, workRest, doubleClickBack, 0)).toBe(0);

    // Center springs a turn back to front and returns a pixel-identical work view, before any scaling.
    await drag(app, page, side, { x: 80, y: -40 });
    await waitFor(page, "the phone turned again", turnedTo(24, 12), 10_000);
    await center(page);
    await waitFor(page, "the phone centred", (s) => turnedTo(0, 0)(s) && s.view.t === 0 && !s.view.active && s.settled && s.laidOut && s.window.w === ended.window.w && s.window.h === ended.window.h, 20_000);
    await frames(page, 3);
    const workBack = await page.screenshot({ path: "test-results/turn-work-reset.png" });
    expect(await differingPixels(page, workRest, workBack, 0)).toBe(0);

    // A far turn from the right side, leftwards and up, stays inside the grown window.
    await drag(app, page, { x: ended.window.w - side.x, y: side.y }, { x: -200, y: -150 });
    await waitFor(page, "the phone turned far", turnedTo(-60, 45), 10_000);
    await windowAtRest(page);
    await frames(page, 3);
    const shotFar = await page.screenshot({ path: "test-results/turn-far.png" });
    expect(await opaqueBox(page, shotFar)).not.toBeNull();
    const farEdges = await edgeCoverage(page, shotFar);
    for (const side of ["top", "bottom", "left", "right"] as const) expect(farEdges[side], `turned phone cut off at the ${side}`).toBeLessThan(0.03);

    const unscaled = (await stats(page)) as Stats & { pxPerMm: number };
    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.down("Alt");
    await page.mouse.wheel(0, 100);
    await page.keyboard.up("Alt");
    const smaller = (await waitFor(page, "a turned phone to scale down a step", (s) => !s.scaling && (s as Stats & { pxPerMm: number }).pxPerMm < unscaled.pxPerMm, 10_000)) as Stats & { pxPerMm: number };
    expect(smaller.pxPerMm / unscaled.pxPerMm).toBeCloseTo(0.9, 2);
    expect(smaller.modelRotation).toEqual({ yaw: -60, pitch: 45 });

    await center(page);
    const workAgain = await waitFor(page, "Center to spring the turn back", (s) => turnedTo(0, 0)(s) && s.view.t === 0 && !s.view.active && s.settled && s.laidOut, 20_000);

    // Turning once more, and scaling up while turned keeps the turn.
    await drag(app, page, await sideOfCase(page, workAgain.window.h / 2), { x: 60, y: 30 });
    await waitFor(page, "the phone turned again", (s) => turnedTo(18, -9)(s), 10_000);
    await page.keyboard.down("Alt");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Alt");
    const bigger = (await waitFor(page, "a turned phone to scale up a step", (s) => !s.scaling && (s as Stats & { pxPerMm: number }).pxPerMm > smaller.pxPerMm, 10_000)) as Stats & { pxPerMm: number };
    expect(bigger.pxPerMm / smaller.pxPerMm).toBeCloseTo(1 / 0.9, 2);
    expect(bigger.modelRotation).toEqual({ yaw: 18, pitch: -9 });
  } finally {
    await app.close();
  }
});

interface UnlockStats { open: boolean; mode: string; busy: boolean; prompt: string; entered: number }

function unlockStats(page: Page): Promise<UnlockStats | null> {
  return page.evaluate(() => (window as unknown as { __hinge?: { unlock(): UnlockStats } }).__hinge?.unlock() ?? null);
}

async function waitForUnlock(page: Page, what: string, ok: (u: UnlockStats) => boolean, timeoutMs = 10_000): Promise<UnlockStats> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const u = await unlockStats(page);
    if (u && ok(u)) return u;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(u)}`);
    await page.waitForTimeout(100);
  }
}

async function tapUnlock(page: Page, id: string): Promise<void> {
  let point: { x: number; y: number } | null = null;
  const deadline = Date.now() + 10_000;
  while (!point && Date.now() < deadline) {
    point = await page.evaluate((key) => (window as unknown as { __hinge: { unlockPoint(k: string): { x: number; y: number } | null } }).__hinge.unlockPoint(key), id);
    if (!point) await page.waitForTimeout(100);
  }
  if (!point) throw new Error(`no point for unlock key ${id}`);
  await page.mouse.click(point.x, point.y);
}

test("MOD+l opens hinge's unlock pad; with no phone a PIN is answered with 'No phone connected', and Escape hides it", async () => {
  test.setTimeout(60_000);
  const { app, page } = await launch(resolve("test/fixtures/synthetic-fold.hrec"));
  try {
    await waitFor(page, "the closed phone", (s) => restingOn("cover", s) && s.framesDecoded > 10, 30_000);
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyL");
    await page.keyboard.up("Alt");
    await waitForUnlock(page, "the PIN pad", (u) => u.open && u.mode === "pin");
    for (const key of ["1", "2", "3", "4"]) await tapUnlock(page, key);
    expect((await unlockStats(page))?.entered).toBe(4);
    await tapUnlock(page, "ok");
    await waitForUnlock(page, "the no-phone answer", (u) => u.prompt === "No phone connected" && u.entered === 0 && !u.busy);
    await page.screenshot({ path: "test-results/unlock-pad.png" });
    await page.keyboard.press("Escape");
    await waitForUnlock(page, "the pad hidden", (u) => !u.open);
  } finally {
    await app.close();
  }
});
