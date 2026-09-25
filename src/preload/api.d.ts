export interface HingeApi {
  setContentSize(w: number, h: number): void;
  setWindowSize(w: number, h: number, rotation: 0 | 1 | 2 | 3): void;
  beginDrag(): void;
  endDrag(): void;
  workAreaHeight(): Promise<number>;
}
declare global {
  interface Window {
    hinge: HingeApi;
  }
}
