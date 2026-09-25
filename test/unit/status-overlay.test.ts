import { expect, test } from "vitest";
import { StatusOverlay, type OverlayCanvas, type OverlayTexture } from "../../src/renderer/status-overlay";

function fakeCtx(): CanvasRenderingContext2D {
  return {
    clearRect() {},
    fillRect() {},
    fillText() {},
    measureText: () => ({ width: 10 }) as TextMetrics,
    set fillStyle(_v: unknown) {},
    set textAlign(_v: unknown) {},
    set textBaseline(_v: unknown) {},
    set font(_v: unknown) {},
  } as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(): OverlayCanvas {
  const ctx = fakeCtx();
  return {
    width: 1,
    height: 1,
    getContext: () => ctx,
  };
}

function fakeTexture(disposeCalls: { count: number }): OverlayTexture {
  return {
    needsUpdate: false,
    dispose() {
      disposeCalls.count++;
    },
  };
}

test("I3: applySize disposes the previous texture and creates a fresh one when the pixel size changes", () => {
  const disposeCalls = { count: 0 };
  const made: OverlayTexture[] = [];
  const overlay = new StatusOverlay({
    canvas: fakeCanvas(),
    makeTexture: (canvas) => {
      const t = fakeTexture(disposeCalls);
      made.push(t);
      return t;
    },
  });
  expect(made).toHaveLength(1);
  expect(disposeCalls.count).toBe(0);

  overlay.applySize(200, 100);
  expect(disposeCalls.count).toBe(1);
  expect(made).toHaveLength(2);
});

test("I3: applySize does not dispose or recreate the texture when the pixel size is unchanged", () => {
  const disposeCalls = { count: 0 };
  const made: OverlayTexture[] = [];
  const overlay = new StatusOverlay({
    canvas: fakeCanvas(),
    makeTexture: () => {
      const t = fakeTexture(disposeCalls);
      made.push(t);
      return t;
    },
  });

  overlay.applySize(200, 100);
  expect(disposeCalls.count).toBe(1);
  expect(made).toHaveLength(2);

  // Same CSS size again: no devicePixelRatio in this environment, so the
  // backing pixel size is identical and no texture churn should happen.
  overlay.applySize(200, 100);
  expect(disposeCalls.count).toBe(1);
  expect(made).toHaveLength(2);
});

test("I3: applySize disposes on every distinct pixel size across repeated resizes", () => {
  const disposeCalls = { count: 0 };
  const overlay = new StatusOverlay({
    canvas: fakeCanvas(),
    makeTexture: () => fakeTexture(disposeCalls),
  });

  overlay.applySize(200, 100);
  overlay.applySize(300, 150);
  overlay.applySize(300, 150);
  overlay.applySize(400, 200);

  expect(disposeCalls.count).toBe(3);
});
