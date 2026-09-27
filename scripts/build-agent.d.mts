import type { VendorTarget } from "./fetch-vendor.mjs";

export const TARGETS: Required<VendorTarget>[];
export function javacArgs(opts: { androidJar: string; classesDir: string; sources: string[] }): string[];
export function d8Args(opts: { d8Jar: string; androidJar: string; outputJar: string; classFiles: string[] }): string[];
