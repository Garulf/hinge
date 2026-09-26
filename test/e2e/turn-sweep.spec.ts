import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const softwareGl = process.env.HINGE_E2E_REAL_GPU !== "1";
const PX_PER_DEG = 1 / 0.3;
// A software GL takes about a second a frame, so there the sweeps take
// bigger steps; a real GPU walks the whole range in 5 degree steps.
const STEP_DEG = softwareGl ? 15 : 5;
const MAX_JUMP_PX = 4 * STEP_DEG;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Edges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Stats {
  window: { w: number; h: number };
  lit: string | null;
  settled: boolean;
  angle: number | null;
  brightness: { cover: number; inner: number };
  view: { target: string; t: number; active: boolean };
  modelRotation: { yaw: number; pitch: number };
  turn?: unknown;
  laidOut: boolean;
}

/** laidOut is false while the window has resized but the canvas has not yet followed it. */
function stats(page: Page): Promise<Stats | null> {
  return page.evaluate(() => {
    const api = (window as unknown as { __hinge?: { stats(): Omit<Stats, "laidOut"> } }).__hinge;
    const canvas = document.querySelector("canvas");
    const laidOut = canvas !== null && canvas.width === Math.floor(innerWidth * devicePixelRatio) && canvas.height === Math.floor(innerHeight * devicePixelRatio);
    return api ? { ...api.stats(), laidOut } : null;
  });
}

async function waitFor(page: Page, what: string, matches: (s: Stats) => boolean, timeoutMs: number): Promise<Stats> {
  const deadline = Date.now() + timeoutMs;
  let last: Stats | null = null;
  while (Date.now() < deadline) {
    last = await stats(page);
    if (last && matches(last)) return last;
  }
  throw new Error(`timed out waiting for ${what}; last reading ${JSON.stringify(last)}`);
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

/** The opaque bounding box in CSS px, how much of each outermost row and column is opaque, and how many pixels differ from `other`. */
async function measure(page: Page, png: Buffer, other: Buffer | null): Promise<{ box: Box | null; edges: Edges; differing: number }> {
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
      const image = await decode(a);
      const { data, width, height } = image;
      const opaque = (x: number, y: number) => data[(y * width + x) * 4 + 3] >= 200;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!opaque(x, y)) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      const scale = width / innerWidth;
      const box = maxX < 0 ? null : { x: minX / scale, y: minY / scale, w: (maxX - minX + 1) / scale, h: (maxY - minY + 1) / scale };
      const row = (y: number) => Array.from({ length: width }, (_, x) => opaque(x, y)).filter(Boolean).length / width;
      const column = (x: number) => Array.from({ length: height }, (_, y) => opaque(x, y)).filter(Boolean).length / height;
      const edges = { top: row(0), bottom: row(height - 1), left: column(0), right: column(width - 1) };
      let differing = 0;
      if (b) {
        const second = await decode(b);
        if (second.width !== width || second.height !== height) differing = width * height;
        else for (let i = 0; i < data.length; i++) if (data[i] !== second.data[i]) differing++;
      }
      return { box, edges, differing };
    },
    { a: png.toString("base64"), b: other ? other.toString("base64") : null },
  );
}

interface Sweep {
  name: string;
  yawSign: number;
  pitchSign: number;
  steps: number;
}

const ALL_SWEEPS: Sweep[] = [
  { name: "yaw+", yawSign: 1, pitchSign: 0, steps: 75 / STEP_DEG },
  { name: "yaw-", yawSign: -1, pitchSign: 0, steps: 75 / STEP_DEG },
  { name: "pitch+", yawSign: 0, pitchSign: 1, steps: 60 / STEP_DEG },
  { name: "pitch-", yawSign: 0, pitchSign: -1, steps: 60 / STEP_DEG },
  { name: "both", yawSign: 1, pitchSign: 1, steps: 75 / STEP_DEG },
];
const SWEEPS = softwareGl ? ALL_SWEEPS.filter((sweep) => sweep.name !== "yaw-" && sweep.name !== "pitch+") : ALL_SWEEPS;

interface Record {
  view: string;
  sweep: string;
  target: { yaw: number; pitch: number };
  angles: { yaw: number; pitch: number };
  window: { w: number; h: number };
  box: Box | null;
  edges: Edges;
  shake: number;
  turn?: unknown;
}

async function sweepView(page: Page, view: string, dir: string, records: Record[]): Promise<void> {
  for (const sweep of SWEEPS) {
    const start = await waitFor(page, `${view} at rest`, (s) => s.modelRotation.yaw === 0 && s.modelRotation.pitch === 0 && !s.view.active, 10_000);
    const centre = { x: start.window.w / 2, y: start.window.h / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    let previous: Record | null = null;
    let restEdges: Edges | null = null;
    for (let k = 0; k <= sweep.steps; k++) {
      const target = { yaw: Math.max(-75, Math.min(75, sweep.yawSign * STEP_DEG * k)), pitch: Math.max(-60, Math.min(60, sweep.pitchSign * STEP_DEG * k)) };
      await page.mouse.move(centre.x + target.yaw * PX_PER_DEG, centre.y - target.pitch * PX_PER_DEG, { steps: 2 });
      await frames(page, 3);
      const first = await page.screenshot({ path: join(dir, `${view}-${sweep.name}-${String(k).padStart(2, "0")}.png`) });
      await frames(page, 4);
      const second = await page.screenshot();
      const s = (await stats(page))!;
      const { box, edges, differing } = await measure(page, first, second);
      const record: Record = { view, sweep: sweep.name, target, angles: s.modelRotation, window: s.window, box, edges, shake: differing, turn: s.turn };
      records.push(record);
      const where = `${view} ${sweep.name} at ${JSON.stringify(target)}`;
      expect.soft(Math.abs(s.modelRotation.yaw - target.yaw), `${where}: yaw follows`).toBeLessThan(0.5);
      expect.soft(Math.abs(s.modelRotation.pitch - target.pitch), `${where}: pitch follows`).toBeLessThan(0.5);
      expect.soft(box, `${where}: the phone is visible`).not.toBeNull();
      expect.soft(differing, `${where}: the picture holds still`).toBe(0);
      expect.soft(s.window, `${where}: the window keeps its size`).toEqual(start.window);
      // At rest the work view's phone fills its window, so a side counts as
      // cut off only when the turned phone runs along it further than the
      // phone at rest does.
      restEdges ??= edges;
      for (const side of ["top", "bottom", "left", "right"] as const) expect.soft(edges[side], `${where}: not cut off at the ${side}`).toBeLessThanOrEqual(restEdges[side] + 0.03);
      if (previous?.box && box) {
        const jump = Math.hypot(box.x + box.w / 2 - (previous.box.x + previous.box.w / 2), box.y + box.h / 2 - (previous.box.y + previous.box.h / 2));
        expect.soft(jump, `${where}: the phone does not jump`).toBeLessThan(MAX_JUMP_PX);
      }
      previous = record;
    }
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.keyboard.down("Alt");
    await page.mouse.dblclick(centre.x, centre.y);
    await page.keyboard.up("Alt");
  }
}

for (const scaleFactor of [1, 1.25]) {
  test(`sweeping the Alt+drag turn over its whole range keeps the phone visible, still and inside the window (scale ${scaleFactor})`, async () => {
    test.skip(softwareGl && scaleFactor !== 1, "one scale factor is enough on a software GL");
    test.setTimeout(600_000);
    const userData = await mkdtemp(join(tmpdir(), "hinge-e2e-"));
    const args = [
      resolve("out/main/index.js"),
      "--replay",
      resolve("test/fixtures/synthetic-fold.hrec"),
      "--user-data",
      userData,
      `--force-device-scale-factor=${scaleFactor}`,
      ...(softwareGl ? ["--use-gl=angle", "--use-angle=swiftshader"] : []),
      "--no-sandbox",
    ];
    const app = await electron.launch({ args });
    const page = await app.firstWindow();
    const dir = `test-results/turn-sweep-${scaleFactor}`;
    await mkdir(dir, { recursive: true });
    const records: Record[] = [];
    try {
      await waitFor(
        page,
        "the replay to end",
        (s) => s.lit === null && s.settled && s.laidOut && s.brightness.inner === 0 && s.brightness.cover === 0 && s.angle === 180 && s.window.w > s.window.h,
        90_000,
      );
      await frames(page, 5);
      await sweepView(page, "work", dir, records);
      await page.keyboard.down("Alt");
      await page.keyboard.press("KeyD");
      await page.keyboard.up("Alt");
      await waitFor(page, "the showcase", (s) => s.view.t === 1 && !s.view.active && s.settled && s.laidOut, 20_000);
      await frames(page, 5);
      await sweepView(page, "showcase", dir, records);
    } finally {
      await writeFile(join(dir, "records.json"), JSON.stringify(records, null, 1));
      await app.close();
    }
  });
}

/** The opaque box of a screenshot, in CSS px; the live video changes colours but never alpha. */
async function boxOf(page: Page, png: Buffer): Promise<Box | null> {
  return (await measure(page, png, null)).box;
}

async function liveSweep(page: Page, label: string, dir: string, records: Record[], sweeps: Sweep[]): Promise<void> {
  for (const sweep of sweeps) {
    const start = (await stats(page))!;
    const centre = { x: start.window.w / 2, y: start.window.h / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    for (let k = 0; k <= sweep.steps; k += Math.max(1, Math.round(15 / STEP_DEG))) {
      const target = { yaw: Math.max(-75, Math.min(75, sweep.yawSign * STEP_DEG * k)), pitch: Math.max(-60, Math.min(60, sweep.pitchSign * STEP_DEG * k)) };
      await page.mouse.move(centre.x + target.yaw * PX_PER_DEG, centre.y - target.pitch * PX_PER_DEG, { steps: 2 });
      await frames(page, 2);
      const boxes: (Box | null)[] = [];
      const windows: { w: number; h: number }[] = [];
      const turns: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        const png = await page.screenshot({ path: join(dir, `${label}-${sweep.name}-${String(k).padStart(2, "0")}-${i}.png`) });
        boxes.push(await boxOf(page, png));
        const sample = (await stats(page))!;
        windows.push(sample.window);
        turns.push(sample.turn);
        await frames(page, 2);
      }
      const s = (await stats(page))!;
      const spread = boxes.every((b) => b)
        ? Math.max(...boxes.map((b) => Math.abs(b!.x - boxes[0]!.x) + Math.abs(b!.y - boxes[0]!.y) + Math.abs(b!.w - boxes[0]!.w) + Math.abs(b!.h - boxes[0]!.h)))
        : -1;
      records.push({ view: label, sweep: sweep.name, target, angles: s.modelRotation, window: s.window, box: boxes[0], edges: { top: 0, bottom: 0, left: 0, right: 0 }, shake: spread, turn: { windows, boxes, turns } });
      const where = `${label} ${sweep.name} at ${JSON.stringify(target)}`;
      expect.soft(spread, `${where}: the phone holds still while live video plays`).toBe(0);
      expect.soft(new Set(windows.map((w) => `${w.w}x${w.h}`)).size, `${where}: the window holds its size`).toBe(1);
    }
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.keyboard.down("Alt");
    await page.mouse.dblclick(centre.x, centre.y);
    await page.keyboard.up("Alt");
    await waitFor(page, "rest", (s) => s.modelRotation.yaw === 0 && s.modelRotation.pitch === 0, 10_000);
  }
}

test("sweeping the turn while the phone streams keeps it still, on the cover and on the inner screen", async () => {
  test.skip(softwareGl, "a software GL draws too few frames while the video plays for a per-frame drift to show");
  test.setTimeout(240_000);
  const userData = await mkdtemp(join(tmpdir(), "hinge-e2e-"));
  const args = [
    resolve("out/main/index.js"),
    "--replay",
    resolve("test/fixtures/synthetic-fold.hrec"),
    "--user-data",
    userData,
    "--force-device-scale-factor=1.25",
    ...(softwareGl ? ["--use-gl=angle", "--use-angle=swiftshader"] : []),
    "--no-sandbox",
  ];
  const app = await electron.launch({ args });
  const page = await app.firstWindow();
  const dir = "test-results/turn-sweep-live";
  await mkdir(dir, { recursive: true });
  const records: Record[] = [];
  const [yawOnly, both] = ["yaw+", "both"].map((name) => ALL_SWEEPS.find((sweep) => sweep.name === name)!);
  const quick = [yawOnly, both];
  try {
    await waitFor(page, "the closed phone streaming", (s) => s.lit === "cover" && s.settled && s.laidOut && s.brightness.cover === 1, 30_000);
    await liveSweep(page, "cover-work", dir, records, quick);
    await waitFor(page, "the open phone streaming", (s) => s.lit === "inner" && s.settled && s.laidOut && s.brightness.inner === 1 && s.angle === 180, 45_000);
    await liveSweep(page, "inner-work", dir, records, quick);
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyD");
    await page.keyboard.up("Alt");
    await waitFor(page, "the showcase", (s) => s.view.t === 1 && !s.view.active && s.laidOut, 20_000);
    await liveSweep(page, "inner-showcase", dir, records, quick);
  } finally {
    await writeFile(join(dir, "records.json"), JSON.stringify(records, null, 1));
    await app.close();
  }
});
