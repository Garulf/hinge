import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const scripts = (JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

test("every pack script builds the hinge agent before electron-builder, which only warns when the jar is missing", () => {
  const packs = Object.entries(scripts).filter(([name]) => name.startsWith("pack:"));
  expect(packs.map(([name]) => name).sort()).toEqual(["pack:linux", "pack:release", "pack:win"]);
  for (const [name, command] of packs) {
    const agent = command.indexOf("npm run build-agent");
    expect(agent, name).toBeGreaterThanOrEqual(0);
    expect(agent, name).toBeLessThan(command.indexOf("electron-builder"));
  }
});
