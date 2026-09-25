import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

type Stats = { framesDecoded: number; width: number; height: number; cls: { screen: string; rotated: boolean } | null; window: { w: number; h: number }; laidOut: boolean };

function aspect(s: Stats): number {
  return s.window.w > 0 ? s.window.h / s.window.w : 0;
}

const STATES: Record<string, (s: Stats) => boolean> = {
  cover: (s) => s.framesDecoded > 10 && s.cls?.screen === "cover" && !s.cls.rotated && aspect(s) > 1.9,
  inner: (s) => s.cls?.screen === "inner" && !s.cls.rotated && aspect(s) > 1.0 && aspect(s) < 1.2,
  rotated: (s) => s.cls?.rotated === true,
};

test("replays the synthetic fold recording and follows the size change", async () => {
  const args = ["--replay", resolve("test/fixtures/synthetic-fold.hrec"), "--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"];
  // Defaults to running the unpacked main entry through the electron npm binary;
  // set HINGE_E2E_EXECUTABLE to a packaged build's executable to run against it instead.
  const executablePath = process.env.HINGE_E2E_EXECUTABLE;
  const app = await electron.launch(
    executablePath ? { executablePath, args } : { args: [resolve("out/main/index.js"), ...args] },
  );
  const page = await app.firstWindow();
  // __hinge is assigned at the end of the renderer's module script, which can
  // still be mid-execution right after firstWindow() resolves; fall back to
  // an empty reading until it exists. laidOut is false while the window has
  // resized but the scene has not yet re-laid out for it (seconds on a
  // software GL), when a screenshot would show the old frame in a corner.
  const stats = () =>
    page.evaluate(() => {
      const api = (window as unknown as { __hinge?: { stats(): Omit<Stats, "laidOut"> } }).__hinge;
      const canvas = document.querySelector("canvas");
      const laidOut = canvas !== null && canvas.width === Math.round(innerWidth * devicePixelRatio) && canvas.height === Math.round(innerHeight * devicePixelRatio);
      return api ? { ...api.stats(), laidOut } : { framesDecoded: 0, width: 0, height: 0, cls: null, window: { w: 0, h: 0 }, laidOut };
    });

  // The replay runs in real time while a software GL renders a frame every
  // few hundred milliseconds, so every reading is checked against every
  // state as it arrives rather than waiting for the states one by one.
  const seen = new Map<string, Stats>();
  const photographed = new Set<string>(["rotated"]);
  const deadline = Date.now() + 45_000;
  while ((seen.size < Object.keys(STATES).length || photographed.size < seen.size) && Date.now() < deadline) {
    const s = await stats();
    for (const [name, matches] of Object.entries(STATES)) {
      if (!matches(s)) continue;
      if (!seen.has(name)) seen.set(name, s);
      if (!photographed.has(name) && s.laidOut) {
        await page.screenshot({ path: `test-results/${name}.png` });
        photographed.add(name);
      }
    }
  }
  await app.close();

  expect([...seen.keys()].sort()).toEqual(["cover", "inner", "rotated"]);
  expect(seen.get("cover")!.cls).toEqual({ screen: "cover", rotated: false });
});
