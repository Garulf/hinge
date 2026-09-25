export interface HingeApi {
  setWindowSize(w: number, h: number, rotation: 0 | 1 | 2 | 3): void;
  beginDrag(): void;
  endDrag(): void;
  /** The size of the display work area the window is on, in CSS px. */
  workArea(): Promise<{ width: number; height: number }>;
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
