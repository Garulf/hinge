export interface HingeApi {
  setWindowSize(w: number, h: number, rotation: 0 | 1 | 2 | 3): void;
  beginDrag(): void;
  endDrag(): void;
  workAreaHeight(): Promise<number>;
  /** process.platform of the app, e.g. "linux", "win32". */
  readonly platform: string;
}
declare global {
  interface Window {
    hinge: HingeApi;
  }
}
