export interface MaterialLook {
  baseColor: string;
  metallic: number;
  roughness: number;
}

/** The shape of model/colorways.json. */
export interface ColourwayFile {
  default: string;
  colorways: Record<string, { label: string; materials: Record<string, MaterialLook> }>;
}

export interface Colourway {
  id: string;
  label: string;
  /** Keyed by glTF material name. */
  materials: Record<string, MaterialLook>;
}

/** The named colourway, matched ignoring case; an unknown name (an old or hand-edited setting) falls back to the file's default. */
export function colourwayFor(file: ColourwayFile, id: string | null | undefined): Colourway {
  const wanted = (id ?? "").toLowerCase();
  const match = Object.keys(file.colorways).find((key) => key.toLowerCase() === wanted) ?? file.default;
  const entry = file.colorways[match];
  if (!entry) throw new Error(`colorways.json has no default colourway ${file.default}`);
  return { id: match, label: entry.label, materials: entry.materials };
}

/** Every colourway with the frame colour to draw its swatch with, in file order. */
export function colourwaySwatches(file: ColourwayFile): { id: string; label: string; swatch: string }[] {
  return Object.entries(file.colorways).map(([id, entry]) => ({ id, label: entry.label, swatch: entry.materials.frame?.baseColor ?? "#808080" }));
}
