import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const buildDir = join(repoRoot, "build");
const svgPath = join(buildDir, "icon.svg");

export const PNG_SIZE = 512;
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

async function main() {
  const svg = readFileSync(svgPath, "utf8");

  const png512 = renderPng(svg, PNG_SIZE);
  writeFileSync(join(buildDir, "icon.png"), png512);
  console.log(`wrote build/icon.png (${PNG_SIZE}x${PNG_SIZE})`);

  const tempDir = mkdtempSync(join(tmpdir(), "hinge-icon-"));
  try {
    const icoInputs = ICO_SIZES.map((size) => {
      const path = join(tempDir, `icon-${size}.png`);
      writeFileSync(path, renderPng(svg, size));
      return path;
    });
    const ico = await pngToIco(icoInputs);
    writeFileSync(join(buildDir, "icon.ico"), ico);
    console.log(`wrote build/icon.ico (${ICO_SIZES.join(", ")})`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
