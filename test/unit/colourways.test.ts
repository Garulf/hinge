import { expect, test } from "vitest";
import colorways from "../../model/colorways.json";
import { colourwayFor, colourwaySwatches, type ColourwayFile } from "../../src/shared/colourways";

const file = colorways as ColourwayFile;

test("a colourway maps each colorways.json material name to its look", () => {
  const mint = colourwayFor(file, "mint");
  expect(mint.label).toBe("Mint");
  expect(mint.materials.frame).toEqual({ baseColor: "#cddcd2", metallic: 1, roughness: 0.35 });
  expect(Object.keys(mint.materials).sort()).toEqual(["antenna_band", "back_glass", "button", "camera_island", "frame", "hinge_spine"]);
});

test("names match ignoring case, and an unknown name falls back to Jet Black", () => {
  expect(colourwayFor(file, "Blue-Shadow").id).toBe("blue-shadow");
  expect(colourwayFor(file, "Jetblack").id).toBe("jetblack");
  expect(colourwayFor(file, "gold").id).toBe("jetblack");
  expect(colourwayFor(file, null).id).toBe("jetblack");
});

test("swatches list every colourway with its frame colour", () => {
  expect(colourwaySwatches(file)).toEqual([
    { id: "jetblack", label: "Jet Black", swatch: "#141414" },
    { id: "blue-shadow", label: "Blue Shadow", swatch: "#232d4e" },
    { id: "silver-shadow", label: "Silver Shadow", swatch: "#b8b6b2" },
    { id: "mint", label: "Mint", swatch: "#cddcd2" },
  ]);
});
