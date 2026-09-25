export interface HingeApi {
  onPort(fn: (port: MessagePort) => void): void;
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
