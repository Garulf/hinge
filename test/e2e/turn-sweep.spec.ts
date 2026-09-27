import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clampModelAngles } from "../../src/shared/model-rotation";

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
  view: { t: number; active: boolean };
  modelRotation: { yaw: number; pitch: number };
  turn?: unknown;
  rotation: number;
  badge: string | null;
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

/**
 * Waits for the window to stop resizing after a turn step (it grows around
 * the turned phone): laid out, at the same size a few frames apart.
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

function contentBounds(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
}

/** Puts the pointer on a point of the screen, wherever the window has moved to under it, as a real mouse would be. */
async function moveOnScreen(app: ElectronApplication, page: Page, point: { x: number; y: number }, steps = 1): Promise<void> {
  const origin = await contentBounds(app);
  await page.mouse.move(point.x - origin.x, point.y - origin.y, { steps });
}

/** Waits for the window to give back a turn's room, which it does once the phone is straight on again. */
async function windowBackTo(app: ElectronApplication, rest: { x: number; y: number; width: number; height: number }): Promise<void> {
  const deadline = Date.now() + 10_000;
  let now = await contentBounds(app);
  while (Date.now() < deadline && JSON.stringify(now) !== JSON.stringify(rest)) now = await contentBounds(app);
  expect(now, "the window gives the room back once the phone is straight on").toEqual(rest);
}

/** The window's centre on the screen, which a turn's room grows the window evenly around. */
async function windowCentre(app: ElectronApplication): Promise<{ x: number; y: number }> {
  const b = await contentBounds(app);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
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

/** MOD+d: turns the phone back to straight on. */
async function center(page: Page): Promise<void> {
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyD");
  await page.keyboard.up("Alt");
}

function pressAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([x, y]) => (window as unknown as { __hinge: { pressAt(x: number, y: number): string } }).__hinge.pressAt(x, y), [x, y]);
}

/**
 * A point on the left side of the case halfway down, found by walking in
 * from the window's left edge: halfway across the bezel beside a lit
 * screen, or a few pixels in when nothing is lit there.
 */
async function sideOfCase(page: Page, s: Stats): Promise<{ x: number; y: number }> {
  const y = s.window.h / 2;
  let start = 0;
  while (start < 400 && (await pressAt(page, start, y)) === "move") start++;
  let end = start;
  while (end < start + 12 && (await pressAt(page, end, y)) === "turn") end++;
  const x = start + Math.min((end - start) / 2, 6);
  expect(await pressAt(page, x, y), `the side of the case at ${x}, ${y}`).toBe("turn");
  return { x, y };
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
  maxDeg: number;
}

/**
 * yaw+ and yaw- each walk a full 360 degree circle (the wrap at 180 is
 * inside the range, not the edge of it); pitch keeps its own +-60 clamp;
 * "both" turns pitch up to its clamp while yaw keeps going round.
 */
const ALL_SWEEPS: Sweep[] = [
  { name: "yaw+", yawSign: 1, pitchSign: 0, maxDeg: 360 },
  { name: "yaw-", yawSign: -1, pitchSign: 0, maxDeg: 360 },
  { name: "pitch+", yawSign: 0, pitchSign: 1, maxDeg: 60 },
  { name: "pitch-", yawSign: 0, pitchSign: -1, maxDeg: 60 },
  { name: "both", yawSign: 1, pitchSign: 1, maxDeg: 360 },
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

/**
 * The angle a sweep step resolves to (yaw wraps, pitch clamps, exactly as
 * RotateGesture does) and the pointer offset that reaches it. Yaw needs the
 * whole unwrapped offset, but pitch stops at its clamp, so the pointer
 * stops there too: pushing further only runs it up into the window's top
 * edge, where the hover menu fades in over the picture being measured.
 */
function targetFor(sweep: Sweep, k: number): { dx: number; dy: number; yaw: number; pitch: number } {
  const rawYaw = sweep.yawSign * STEP_DEG * k;
  const pitch = Math.max(-60, Math.min(60, sweep.pitchSign * STEP_DEG * k));
  return { dx: rawYaw * PX_PER_DEG, dy: -pitch * PX_PER_DEG, yaw: clampModelAngles({ yaw: rawYaw, pitch: 0 }).yaw, pitch };
}

/**
 * Every sweep here turns the phone by dragging the left side of its case,
 * starting straight on, and Center brings it back after each. `restEdges` is
 * the straight-on framing, measured once up front.
 */
async function sweepFromSide(app: ElectronApplication, page: Page, dir: string, records: Record[], restEdges: Edges): Promise<void> {
  for (const sweep of SWEEPS) {
    await waitFor(page, "rest before a sweep", (s) => s.modelRotation.yaw === 0 && s.modelRotation.pitch === 0 && !s.view.active, 10_000);
    const side = await sideOfCase(page, await windowAtRest(page));
    const rest = await contentBounds(app);
    const restCentre = await windowCentre(app);
    const onScreen = { x: rest.x + side.x, y: rest.y + side.y };
    await page.mouse.move(side.x, side.y);
    await page.mouse.down();
    let previous: Record | null = null;
    const steps = sweep.maxDeg / STEP_DEG;
    for (let k = 0; k <= steps; k++) {
      const { dx, dy, yaw, pitch } = targetFor(sweep, k);
      await moveOnScreen(app, page, { x: onScreen.x + dx, y: onScreen.y + dy }, 2);
      await windowAtRest(page);
      const first = await page.screenshot({ path: join(dir, `turn-${sweep.name}-${String(k).padStart(2, "0")}.png`) });
      await frames(page, 4);
      const second = await page.screenshot();
      const s = (await stats(page))!;
      const { box, edges, differing } = await measure(page, first, second);
      const record: Record = { view: "ended", sweep: sweep.name, target: { yaw, pitch }, angles: s.modelRotation, window: s.window, box, edges, shake: differing, turn: s.turn };
      records.push(record);
      const where = `${sweep.name} at ${JSON.stringify({ yaw, pitch })}`;
      expect.soft(Math.abs(s.modelRotation.yaw - yaw), `${where}: yaw follows`).toBeLessThan(0.5);
      expect.soft(Math.abs(s.modelRotation.pitch - pitch), `${where}: pitch follows`).toBeLessThan(0.5);
      expect.soft(box, `${where}: the phone is visible`).not.toBeNull();
      expect.soft(differing, `${where}: the picture holds still`).toBe(0);
      const windowAt = await windowCentre(app);
      expect.soft(Math.hypot(windowAt.x - restCentre.x, windowAt.y - restCentre.y), `${where}: the window grows evenly around the phone`).toBeLessThanOrEqual(1);
      for (const side of ["top", "bottom", "left", "right"] as const) expect.soft(edges[side], `${where}: not cut off at the ${side}`).toBeLessThanOrEqual(restEdges[side] + 0.03);
      if (previous?.box && box) {
        const offset = (r: Record) => ({ x: r.box!.x + r.box!.w / 2 - r.window.w / 2, y: r.box!.y + r.box!.h / 2 - r.window.h / 2 });
        const [now, before] = [offset(record), offset(previous)];
        const jump = Math.hypot(now.x - before.x, now.y - before.y);
        expect.soft(jump, `${where}: the phone does not jump`).toBeLessThan(MAX_JUMP_PX);
      }
      previous = record;
    }
    await page.mouse.up();
    await center(page);
    await windowBackTo(app, rest);
  }
}

for (const scaleFactor of [1, 1.25]) {
  test(`sweeping a turn by the case's side over the full 360 degree yaw range keeps the phone visible, still and inside the window (scale ${scaleFactor})`, async () => {
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
      const workRestBefore = await page.screenshot({ path: join(dir, "work-rest-before.png") });
      const { box: restBox, edges: restEdges } = await measure(page, workRestBefore, null);
      expect(restBox).not.toBeNull();

      await sweepFromSide(app, page, dir, records, restEdges);

      await waitFor(
        page,
        "the work view after the sweep, front-on",
        (s) => s.view.t === 0 && !s.view.active && s.settled && s.laidOut && s.modelRotation.yaw === 0 && s.modelRotation.pitch === 0,
        20_000,
      );
      await frames(page, 5);
      const workRestAfter = await page.screenshot({ path: join(dir, "work-rest-after.png") });
      expect((await measure(page, workRestBefore, workRestAfter)).differing).toBe(0);
    } finally {
      await writeFile(join(dir, "records.json"), JSON.stringify(records, null, 1));
      await app.close();
    }
  });
}

interface DragSample {
  dx: number;
  yaw: number;
  pitch: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Pointer offsets on the screen for a drag out to the right and back past
 * the start to the left, a frame apart: the two directions in which the
 * window growing under a pointer read in window coordinates once ran the
 * turn away and made it shake.
 */
const DRAG_OFFSETS_PX = [...Array.from({ length: 12 }, (_, i) => 15 * (i + 1)), ...Array.from({ length: 24 }, (_, i) => 180 - 15 * (i + 1))];

interface TurnGrip {
  name: string;
  alt: boolean;
  pressAt: (page: Page, s: Stats) => Promise<{ x: number; y: number }>;
}

const TURN_GRIPS: TurnGrip[] = [
  { name: "the side of the case", alt: false, pressAt: sideOfCase },
  { name: "Alt+drag", alt: true, pressAt: async (_page, s) => ({ x: s.window.w / 2, y: s.window.h / 2 }) },
];

for (const scaleFactor of [1, 1.25]) {
  for (const grip of TURN_GRIPS) {
    test(`a turn by ${grip.name} follows the pointer's travel on the screen and never resizes the window mid-turn (scale ${scaleFactor})`, async () => {
      test.skip(softwareGl && scaleFactor !== 1, "one scale factor is enough on a software GL");
      test.setTimeout(300_000);
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
      const samples: DragSample[] = [];
      try {
        const open = await waitFor(page, "the replay to end, open", (s) => s.lit === null && s.settled && s.laidOut && s.angle === 180 && s.window.w > s.window.h, 90_000);
        const rest = await contentBounds(app);
        const from = await grip.pressAt(page, open);
        const onScreen = { x: rest.x + from.x, y: rest.y + from.y };
        await page.mouse.move(from.x, from.y);
        if (grip.alt) await page.keyboard.down("Alt");
        await page.mouse.down();
        for (const dx of DRAG_OFFSETS_PX) {
          await moveOnScreen(app, page, { x: onScreen.x + dx, y: onScreen.y });
          await frames(page, 1);
          const s = (await stats(page))!;
          samples.push({ dx, yaw: s.modelRotation.yaw, pitch: s.modelRotation.pitch, bounds: await contentBounds(app) });
        }
        await page.mouse.up();
        if (grip.alt) await page.keyboard.up("Alt");

        for (const { dx, yaw, pitch } of samples) {
          expect.soft(Math.abs(yaw - 0.3 * dx), `at ${dx} px: the yaw follows the pointer on the screen`).toBeLessThan(0.5);
          expect.soft(Math.abs(pitch), `at ${dx} px: a sideways drag does not tip the phone`).toBeLessThan(0.5);
        }
        const grown = samples.findIndex((sample) => sample.bounds.width !== rest.width || sample.bounds.height !== rest.height);
        expect(grown, "the window grows for the turn").toBeGreaterThanOrEqual(0);
        const room = samples[grown].bounds;
        for (const { dx, bounds } of samples.slice(grown)) expect.soft(bounds, `at ${dx} px: the window holds still while the phone turns`).toEqual(room);
        expect(Math.abs(room.x + room.width / 2 - (rest.x + rest.width / 2)), "the window grows evenly around the phone").toBeLessThanOrEqual(1);
        expect(Math.abs(room.y + room.height / 2 - (rest.y + rest.height / 2)), "the window grows evenly around the phone").toBeLessThanOrEqual(1);

        await center(page);
        await waitFor(page, "the turn back at rest", (s) => s.modelRotation.yaw === 0 && s.modelRotation.pitch === 0 && !s.view.active, 10_000);
        await windowBackTo(app, rest);
      } finally {
        await mkdir("test-results", { recursive: true });
        await writeFile(`test-results/turn-drag-${grip.alt ? "alt" : "side"}-${scaleFactor}.json`, JSON.stringify(samples, null, 1));
        await app.close();
      }
    });
  }
}

/** The opaque box of a screenshot, in CSS px; the live video changes colours but never alpha. */
async function boxOf(page: Page, png: Buffer): Promise<Box | null> {
  return (await measure(page, png, null)).box;
}

interface LivePose {
  name: "cover" | "inner";
  /**
   * The replay holds this pose, streaming, from when it matches until the
   * phone opens (cover, about 13 s) or turns to landscape (inner, about
   * 27 s). The work view draws the phone flat while it rests half open in
   * Flex mode, so the inner pose also waits for the Flex badge to go.
   */
  matches: (s: Stats) => boolean;
  /** How many launches a 360 degree sweep is split over, so each part fits inside the hold with seconds to spare (a whole one takes about 11.5 s). */
  parts: number;
}

const LIVE_POSES: LivePose[] = [
  { name: "cover", parts: 2, matches: (s) => s.lit === "cover" && s.settled && s.laidOut && s.brightness.cover === 1 && s.angle === 0 && s.rotation === 0 },
  { name: "inner", parts: 1, matches: (s) => s.lit === "inner" && s.settled && s.laidOut && s.brightness.inner === 1 && s.angle === 180 && s.badge === null && s.rotation === 0 },
];

interface LiveSample {
  k: number;
  /** Since the sweep's pose was first seen, to show how much of the replay's hold the sweep used. */
  atMs: number;
  yaw: number;
  pitch: number;
  shots: Buffer[];
  samples: Stats[];
}

/**
 * One sweep with the pointer held still at each step while the stream keeps
 * redrawing the scene, four screenshots two frames apart. The replay moves
 * on by itself (the phone opens, then turns to landscape), and a sweep that
 * outlasted its pose would read that real motion as a shake, so every
 * sample first checks the replay still holds the pose the sweep started in.
 * The screenshots are measured after the sweep, keeping each step short.
 * Only the steps of `part` (of `pose.parts`) are sampled; the drag still
 * passes through the earlier ones on its way there.
 */
async function liveSweep(app: ElectronApplication, page: Page, pose: LivePose, sweep: Sweep, part: number, dir: string, records: Record[], poseSeenMs: number): Promise<void> {
  const start = (await stats(page))!;
  const side = await sideOfCase(page, start);
  const origin = await contentBounds(app);
  const onScreen = { x: origin.x + side.x, y: origin.y + side.y };
  await page.mouse.move(side.x, side.y);
  await page.mouse.down();
  const taken: LiveSample[] = [];
  const steps = sweep.maxDeg / STEP_DEG;
  const stride = Math.max(1, Math.round(15 / STEP_DEG));
  const sampled = (k: number) => Math.min(pose.parts - 1, Math.floor((k / (steps + stride)) * pose.parts)) === part;
  for (let k = 0; k <= steps; k += stride) {
    const { dx, dy, yaw, pitch } = targetFor(sweep, k);
    await moveOnScreen(app, page, { x: onScreen.x + dx, y: onScreen.y + dy }, 2);
    await windowAtRest(page);
    if (!sampled(k)) continue;
    const sample: LiveSample = { k, atMs: Date.now() - poseSeenMs, yaw, pitch, shots: [], samples: [] };
    for (let i = 0; i < 4; i++) {
      sample.shots.push(await page.screenshot({ path: join(dir, `${pose.name}-${sweep.name}-${String(k).padStart(2, "0")}-${i}.png`) }));
      const s = (await stats(page))!;
      sample.samples.push(s);
      expect(pose.matches(s), `${pose.name} ${sweep.name} at ${JSON.stringify({ yaw, pitch })}: the replay still holds the ${pose.name} pose (lit ${s.lit}, angle ${s.angle}, rotation ${s.rotation})`).toBe(true);
      await frames(page, 2);
    }
    taken.push(sample);
  }
  await page.mouse.up();

  for (const { k, atMs, yaw, pitch, shots, samples } of taken) {
    const boxes = await Promise.all(shots.map((png) => boxOf(page, png)));
    const spread = boxes.every((b) => b)
      ? Math.max(...boxes.map((b) => Math.abs(b!.x - boxes[0]!.x) + Math.abs(b!.y - boxes[0]!.y) + Math.abs(b!.w - boxes[0]!.w) + Math.abs(b!.h - boxes[0]!.h)))
      : -1;
    const windows = samples.map((s) => s.window);
    const last = samples.at(-1)!;
    records.push({ view: pose.name, sweep: sweep.name, target: { yaw, pitch }, angles: last.modelRotation, window: last.window, box: boxes[0], edges: { top: 0, bottom: 0, left: 0, right: 0 }, shake: spread, turn: { k, atMs, windows, boxes, turns: samples.map((s) => s.turn) } });
    const where = `${pose.name} ${sweep.name} at ${JSON.stringify({ yaw, pitch })}`;
    expect.soft(Math.abs(last.modelRotation.yaw - yaw), `${where}: yaw follows`).toBeLessThan(0.5);
    expect.soft(Math.abs(last.modelRotation.pitch - pitch), `${where}: pitch follows`).toBeLessThan(0.5);
    expect.soft(spread, `${where}: the phone holds still while live video plays`).toBe(0);
    expect.soft(new Set(windows.map((w) => `${w.w}x${w.h}`)).size, `${where}: the window holds its size`).toBe(1);
  }
}

/**
 * Each pose and sweep (or part of one) gets its own launch of the replay:
 * two full 360 degree sweeps take longer than the replay holds the phone
 * closed, so run back to back they would still be sampling while the phone
 * unfolds.
 */
for (const pose of LIVE_POSES) {
  for (const sweep of ALL_SWEEPS.filter((s) => s.name === "yaw+" || s.name === "both")) {
    for (let part = 0; part < pose.parts; part++) {
      const partName = pose.parts > 1 ? `, part ${part + 1} of ${pose.parts}` : "";
      test(`sweeping the turn while the phone streams keeps it still (${pose.name}, ${sweep.name}${partName})`, async () => {
        test.skip(softwareGl, "a software GL draws too few frames while the video plays for a per-frame drift to show");
        test.setTimeout(120_000);
        const userData = await mkdtemp(join(tmpdir(), "hinge-e2e-"));
        const args = [resolve("out/main/index.js"), "--replay", resolve("test/fixtures/synthetic-fold.hrec"), "--user-data", userData, "--force-device-scale-factor=1.25", "--no-sandbox"];
        const app = await electron.launch({ args });
        const page = await app.firstWindow();
        const dir = "test-results/turn-sweep-live";
        await mkdir(dir, { recursive: true });
        const records: Record[] = [];
        try {
          await waitFor(page, `the ${pose.name} pose streaming`, pose.matches, 45_000);
          await liveSweep(app, page, pose, sweep, part, dir, records, Date.now());
        } finally {
          await writeFile(join(dir, `records-${pose.name}-${sweep.name}-${part + 1}.json`), JSON.stringify(records, null, 1));
          await app.close();
        }
      });
    }
  }
}
