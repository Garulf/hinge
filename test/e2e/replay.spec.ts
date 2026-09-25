import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FOLD7_BODY, showcaseSizePx } from "../../src/shared/layout";

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
  view: { target: "work" | "showcase"; t: number; active: boolean };
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

async function launch(recording: string): Promise<{ app: ElectronApplication; page: Page }> {
  const args = ["--replay", recording, ...(softwareGl ? ["--use-gl=angle", "--use-angle=swiftshader"] : []), "--no-sandbox"];
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
        view: { target: "work" as const, t: 0, active: false },
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

async function toggleView(page: Page): Promise<void> {
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyD");
  await page.keyboard.up("Alt");
}

/** Fraction of pixels in which any channel differs by more than a compression step between two same-size screenshots. */
async function differingPixels(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ({ a, b }) => {
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
        if ([0, 1, 2, 3].some((c) => Math.abs(x.data[i + c] - y.data[i + c]) > 16)) differing++;
      }
      return differing / (x.width * x.height);
    },
    { a: a.toString("base64"), b: b.toString("base64") },
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

    await toggleView(page);
    const pxPerMmOpen = open.window.h / FOLD7_BODY.heightMm;
    const showcaseWidth = showcaseSizePx(FOLD7_BODY, 0, pxPerMmOpen).w;
    const showcase = await waitFor(
      page,
      "the showcase view",
      (s) => s.view.target === "showcase" && s.view.t === 1 && !s.view.active && s.laidOut && Math.abs(s.window.w - showcaseWidth) <= 4 && s.window.h === open.window.h,
      20_000,
    );
    expect(showcase.lit).toBe("inner");
    await page.screenshot({ path: "test-results/showcase-open.png" });

    await toggleView(page);
    await waitFor(page, "the work view again", (s) => s.view.target === "work" && s.view.t === 0 && !s.view.active && restingOn("inner", s) && s.window.w === open.window.w && s.window.h === open.window.h, 20_000);
    expect(await windowBounds(app)).toEqual(openBounds);
    const workAgainShot = await page.screenshot({ path: "test-results/open-after-showcase.png" });
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
