export interface HingeApi {
  setContentSize(w: number, h: number): void;
  beginDrag(): void;
  endDrag(): void;
  workAreaHeight(): Promise<number>;
}
declare global {
  interface Window {
    hinge: HingeApi;
  }
}
