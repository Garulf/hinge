import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("replays the synthetic fold recording and follows the size change", async () => {
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), "--replay", resolve("test/fixtures/synthetic-fold.hrec"), "--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await app.firstWindow();
  type Stats = { framesDecoded: number; width: number; height: number; cls: { screen: string; rotated: boolean } | null; window: { w: number; h: number } };
  // __hinge is assigned at the end of the renderer's module script, which can
  // still be mid-execution right after firstWindow() resolves; fall back to
  // an empty reading instead of throwing so expect.poll can retry.
  const stats = () =>
    page.evaluate(() => {
      const api = (window as unknown as { __hinge?: { stats(): Stats } }).__hinge;
      return api ? api.stats() : { framesDecoded: 0, width: 0, height: 0, cls: null, window: { w: 0, h: 0 } };
    });

  // Each segment lasts only 1-2 real-time seconds, and software H.264 decode
  // under Xvfb + SwiftShader is slow enough that gating a segment's
  // assertions on a frame count can outlast the segment itself. Confirm each
  // classification (and grab its screenshot) as soon as any frame has
  // decoded, then check the >10 threshold once at the end, by which point
  // the run has been decoding for multiple segments.
  await expect.poll(async () => (await stats()).cls?.screen, { timeout: 15_000 }).toBe("cover");
  await expect.poll(async () => (await stats()).framesDecoded, { timeout: 15_000 }).toBeGreaterThan(0);
  const cover = await stats();
  expect(cover.cls).toEqual({ screen: "cover", rotated: false });
  expect(cover.window.h / cover.window.w).toBeGreaterThan(1.9);
  await page.screenshot({ path: "test-results/cover.png" });

  await expect.poll(async () => (await stats()).cls?.screen, { timeout: 15_000 }).toBe("inner");
  // By now the whole 2-second cover segment has already been decoded in the
  // background, so this threshold has plenty of headroom before the
  // 1-second rotated segment ends the recording and tears the decoder down.
  await expect.poll(async () => (await stats()).framesDecoded, { timeout: 15_000 }).toBeGreaterThan(10);
  const inner = await stats();
  expect(inner.window.h / inner.window.w).toBeGreaterThan(1.0);
  expect(inner.window.h / inner.window.w).toBeLessThan(1.2);
  await page.screenshot({ path: "test-results/inner.png" });

  await expect.poll(async () => (await stats()).cls?.rotated, { timeout: 15_000 }).toBe(true);
  await app.close();
});
