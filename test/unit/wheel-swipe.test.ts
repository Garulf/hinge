import { expect, test } from "vitest";
import { AndroidFling } from "../../src/shared/android-fling";
import { FOLD7_DENSITY, WheelSwipe } from "../../src/shared/wheel-swipe";
import type { ControlIntent } from "../../src/shared/wire";

type Touch = Extract<ControlIntent, { type: "touch" }>;

const COVER = { w: 1080, h: 2520 };
const DP = FOLD7_DENSITY;
const NOTCH = 64 * DP;
const SLOP = 8 * DP;
const fling = new AndroidFling(DP);
const DOWN = { x: 0, y: -1 };

function touches(intents: ControlIntent[]): Touch[] {
  return intents.filter((i): i is Touch => i.type === "touch");
}

/** Runs frames every `frameMs` until the swipe is done, with extra notches fed in at their times. */
function play(swipe: WheelSwipe, start: ControlIntent[], opts: { from?: number; frameMs?: number; notches?: { at: number; units: { x: number; y: number }; point?: { x: number; y: number } }[] } = {}) {
  const frameMs = opts.frameMs ?? 16;
  const notches = [...(opts.notches ?? [])];
  const out = touches(start);
  let now = opts.from ?? 0;
  for (let i = 0; i < 1000 && (swipe.busy || notches.length > 0); i++) {
    now += frameMs;
    while (notches.length > 0 && notches[0].at <= now) {
      const n = notches.shift()!;
      out.push(...touches(swipe.add(n.units, n.point ?? { x: 540, y: 1500 }, COVER, n.at)));
    }
    out.push(...touches(swipe.frame(now)));
  }
  return { out, now };
}

/** How far the content moves: finger travel past the touch slop in each stroke, plus the fling after each lift, less what the next stroke caught. */
function strokes(out: Touch[]): Touch[][] {
  const result: Touch[][] = [];
  for (const t of out) {
    if (t.action === "down") result.push([t]);
    else result[result.length - 1].push(t);
  }
  return result;
}

test("a notch is one finger stroke with the generic finger id: down, moves, then up", () => {
  const swipe = new WheelSwipe();
  const { out } = play(swipe, swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0));
  expect(out[0]).toMatchObject({ action: "down", x: 540, y: 1500, pointerId: -2, videoWidth: 1080, videoHeight: 2520, pressure: 1, buttons: 0 });
  expect(out.at(-1)).toMatchObject({ action: "up", pressure: 0 });
  expect(out.filter((t) => t.action === "down")).toHaveLength(1);
  expect(out.slice(1, -1).every((t) => t.action === "move")).toBe(true);
});

test("scrolling down moves the finger up, and the drag past the slop plus the fling adds up to one notch", () => {
  const swipe = new WheelSwipe();
  const { out } = play(swipe, swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0));
  const ys = out.map((t) => t.y);
  for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);
  const moves = out.filter((t) => t.action === "move");
  const last = moves.at(-1)!;
  const before = moves.at(-2)!;
  const releaseSpeed = ((before.y - last.y) / 16) * 1000;
  const dragged = 1500 - last.y - SLOP;
  expect(Math.abs(dragged + fling.distance(releaseSpeed) - NOTCH)).toBeLessThan(12);
});

test("the finger lifts about 100 ms after the last notch, while still moving", () => {
  const swipe = new WheelSwipe();
  const { out, now } = play(swipe, swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0));
  expect(now).toBeGreaterThanOrEqual(100);
  expect(now).toBeLessThan(140);
  const moves = out.filter((t) => t.action === "move");
  expect(moves.at(-1)!.y).toBeLessThan(moves.at(-2)!.y);
});

test("notches arriving while the finger is down extend the same stroke and speed it up", () => {
  const swipe = new WheelSwipe();
  const single = play(new WheelSwipe(), new WheelSwipe().add(DOWN, { x: 540, y: 1500 }, COVER, 0));
  const { out } = play(swipe, swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0), {
    notches: [40, 80, 120].map((at) => ({ at, units: DOWN })),
  });
  expect(out.filter((t) => t.action === "down")).toHaveLength(1);
  const travel = (o: Touch[]) => o[0].y - o.at(-1)!.y;
  expect(travel(out)).toBeGreaterThan(2 * travel(single.out));
});

test("a notch during the fling catches it with a new stroke that owes what the fling had left", () => {
  const swipe = new WheelSwipe();
  const first = play(swipe, swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0));
  const second = swipe.add(DOWN, { x: 540, y: 1500 }, COVER, first.now + 30);
  expect(touches(second)).toEqual([expect.objectContaining({ action: "down" })]);
  const fresh = new WheelSwipe();
  const alone = play(fresh, fresh.add(DOWN, { x: 540, y: 1500 }, COVER, 0));
  const caught = play(swipe, second, { from: first.now + 30 });
  const travel = (o: Touch[]) => o[0].y - o.at(-1)!.y;
  expect(travel(caught.out)).toBeGreaterThan(travel(alone.out));
});

test("the opposite direction scrolls up, moving the finger down", () => {
  const swipe = new WheelSwipe();
  const { out } = play(swipe, swipe.add({ x: 0, y: 1 }, { x: 540, y: 1000 }, COVER, 0));
  expect(out.at(-1)!.y).toBeGreaterThan(1000);
});

test("horizontal notches move the finger sideways", () => {
  const swipe = new WheelSwipe();
  const { out } = play(swipe, swipe.add({ x: -1, y: 0 }, { x: 540, y: 1000 }, COVER, 0));
  expect(out.at(-1)!.x).toBeLessThan(540);
  expect(out.every((t) => t.y === 1000)).toBe(true);
});

test("the finger never goes down in the gesture areas at the screen edges", () => {
  const swipe = new WheelSwipe();
  const bottom = swipe.add(DOWN, { x: 5, y: 2515 }, COVER, 0)[0] as Touch;
  expect(bottom.y).toBeLessThanOrEqual(2520 - 64 * DP);
  expect(bottom.x).toBeGreaterThanOrEqual(48 * DP);
  swipe.cancel();
  const top = swipe.add({ x: 0, y: 1 }, { x: 1075, y: 10 }, COVER, 0)[0] as Touch;
  expect(top.y).toBeGreaterThanOrEqual(64 * DP);
  expect(top.x).toBeLessThanOrEqual(1080 - 48 * DP);
});

test("a stroke heading for an edge it is close to starts further in, so it has room to travel", () => {
  const swipe = new WheelSwipe();
  const down = swipe.add(DOWN, { x: 540, y: 200 }, COVER, 0)[0] as Touch;
  expect(down.y).toBeGreaterThanOrEqual(64 * DP + 160 * DP - 1);
});

test("a long burst that runs out of room lifts and grips again, all inside the safe area", () => {
  const swipe = new WheelSwipe();
  const notches = Array.from({ length: 40 }, (_, i) => ({ at: (i + 1) * 30, units: DOWN }));
  const { out } = play(swipe, swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0), { notches });
  const list = strokes(out);
  expect(list.length).toBeGreaterThan(1);
  for (const s of list) {
    expect(s[0].action).toBe("down");
    expect(s.at(-1)!.action).toBe("up");
  }
  for (const t of out) {
    expect(t.y).toBeGreaterThanOrEqual(64 * DP - 1);
    expect(t.y).toBeLessThanOrEqual(2520 - 64 * DP + 1);
  }
});

test("cancel lets go with a cancel, not an up, so nothing flings or clicks", () => {
  const swipe = new WheelSwipe();
  swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0);
  swipe.frame(16);
  expect(swipe.cancel()).toEqual([expect.objectContaining({ action: "cancel", pointerId: -2 })]);
  expect(swipe.busy).toBe(false);
  expect(swipe.cancel()).toEqual([]);
});

test("a finger that stalled before moving past the slop is cancelled rather than lifted, so it cannot tap", () => {
  const swipe = new WheelSwipe();
  swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 0);
  expect(swipe.frame(400)).toEqual([expect.objectContaining({ action: "cancel" })]);
  expect(swipe.busy).toBe(false);
});

test("on a downscaled stream the finger works in stream pixels", () => {
  const swipe = new WheelSwipe();
  const half = { w: 540, h: 1260 };
  const down = swipe.add(DOWN, { x: 270, y: 750 }, half, 0)[0] as Touch;
  expect(down).toMatchObject({ x: 270, y: 750, videoWidth: 540, videoHeight: 1260 });
  let last = down;
  for (let now = 16; swipe.busy && now < 1000; now += 16) {
    const [t] = touches(swipe.frame(now));
    if (t) last = t;
  }
  expect(750 - last.y).toBeGreaterThan(20);
  expect(750 - last.y).toBeLessThan(NOTCH / 2);
});

test("a frame stamped a little before the notch that started the stroke does not move the finger backwards", () => {
  const swipe = new WheelSwipe();
  swipe.add(DOWN, { x: 540, y: 1500 }, COVER, 20);
  const [move] = touches(swipe.frame(12));
  expect(move).toMatchObject({ action: "move", y: 1500 });
  const later = play(swipe, [], { from: 12 });
  expect(later.out.at(-1)).toMatchObject({ action: "up" });
  expect(later.out.at(-1)!.y).toBeLessThan(1500);
});
