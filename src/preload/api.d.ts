export interface HingeApi {
  setWindowSize(w: number, h: number, rotation: 0 | 1 | 2 | 3): void;
  beginDrag(): void;
  endDrag(): void;
  workAreaHeight(): Promise<number>;
  /** Resolves a dropped File to its absolute filesystem path; renderer File objects no longer expose .path directly. */
  getPathForFile(file: File): string;
  /** process.platform of the app, e.g. "linux", "win32". */
  readonly platform: string;
}
declare global {
  interface Window {
    hinge: HingeApi;
  }
}
