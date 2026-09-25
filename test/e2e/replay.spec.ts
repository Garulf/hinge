import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("replays the synthetic fold recording and follows the size change", async () => {
  const args = ["--replay", resolve("test/fixtures/synthetic-fold.hrec"), "--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"];
  // Defaults to running the unpacked main entry through the electron npm binary;
  // set HINGE_E2E_EXECUTABLE to a packaged build's executable to run against it instead.
  const executablePath = process.env.HINGE_E2E_EXECUTABLE;
  const app = await electron.launch(
    executablePath ? { executablePath, args } : { args: [resolve("out/main/index.js"), ...args] },
  );
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

  function aspect(s: Stats): number {
    return s.window.w > 0 ? s.window.h / s.window.w : 0;
  }

  // Polling a condition and then re-fetching stats() separately is its own
  // small race, and cls itself can briefly disagree with window.{w,h}: cls
  // updates synchronously in the renderer, but the actual OS window resize
  // is an async round trip through main. Capture the exact reading that
  // satisfies the full predicate, aspect ratio included, instead of
  // re-fetching or checking the aspect only afterwards.
  let cover: Stats | null = null;
  await expect
    .poll(
      async () => {
        const s = await stats();
        if (s.framesDecoded > 10 && s.cls?.screen === "cover" && !s.cls.rotated && aspect(s) > 1.9) cover = s;
        return cover !== null;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(cover!.cls).toEqual({ screen: "cover", rotated: false });
  await page.screenshot({ path: "test-results/cover.png" });

  let inner: Stats | null = null;
  await expect
    .poll(
      async () => {
        const s = await stats();
        if (s.cls?.screen === "inner" && !s.cls.rotated && aspect(s) > 1.0 && aspect(s) < 1.2) inner = s;
        return inner !== null;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/inner.png" });

  await expect.poll(async () => (await stats()).cls?.rotated, { timeout: 15_000 }).toBe(true);
  await app.close();
});
