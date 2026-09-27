export interface VendorTarget {
  file: string;
  url: string;
  algo: string;
  sum: string;
  extractTo?: string;
  innerDir?: string;
  keep?: string[];
}

export const TARGETS: VendorTarget[];
export function selectTargets(targets: VendorTarget[], only: Set<string> | null): VendorTarget[];
export function keptFilesFor(target: VendorTarget): string[];
export function fetchTarget(target: VendorTarget, rootDir?: string): Promise<void>;
