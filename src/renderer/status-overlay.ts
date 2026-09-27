import * as THREE from "three";
import { paintStatus } from "./status-paint";

export interface OverlayCanvas {
  width: number;
  height: number;
  getContext(id: "2d"): CanvasRenderingContext2D | null;
}

export interface OverlayTexture {
  needsUpdate: boolean;
  dispose(): void;
}

function backingSize(w: number, h: number): { pixelW: number; pixelH: number } {
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  return { pixelW: Math.max(1, Math.round(w * dpr)), pixelH: Math.max(1, Math.round(h * dpr)) };
}

export class StatusOverlay {
  readonly mesh: THREE.Mesh;

  #canvas: OverlayCanvas;
  #ctx: CanvasRenderingContext2D;
  #makeTexture: (canvas: OverlayCanvas) => OverlayTexture;
  #texture: OverlayTexture;
  #text: string | null = null;
  #size = { w: 0, h: 0 };

  constructor(opts?: { canvas?: OverlayCanvas; makeTexture?: (canvas: OverlayCanvas) => OverlayTexture }) {
    this.#canvas = opts?.canvas ?? document.createElement("canvas");
    this.#canvas.width = 1;
    this.#canvas.height = 1;
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.#ctx = ctx;
    this.#makeTexture = opts?.makeTexture ?? ((canvas) => new THREE.CanvasTexture(canvas as HTMLCanvasElement));
    this.#texture = this.#makeTexture(this.#canvas);
    const material = new THREE.MeshBasicMaterial({ map: this.#texture as unknown as THREE.Texture, transparent: true, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.visible = false;
  }

  /**
   * Sizes the backing canvas to the screen rect's own aspect ratio and DPR,
   * not a fixed 2:1 box. three (0.186) allocates a CanvasTexture's GPU
   * storage once from the canvas's size at creation, so resizing the
   * backing canvas without recreating the texture would leave it sampling
   * stale storage; dispose and recreate it whenever the pixel size changes.
   */
  applySize(w: number, h: number): void {
    const { pixelW, pixelH } = backingSize(w, h);
    const canvasMatches = this.#canvas.width === pixelW && this.#canvas.height === pixelH;
    if (canvasMatches && w === this.#size.w && h === this.#size.h) return;
    this.#size = { w, h };
    if (!canvasMatches) {
      this.#canvas.width = pixelW;
      this.#canvas.height = pixelH;
      this.#texture.dispose();
      this.#texture = this.#makeTexture(this.#canvas);
      (this.mesh.material as THREE.MeshBasicMaterial).map = this.#texture as unknown as THREE.Texture;
    }
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(w, h);
    this.#redraw();
  }

  get text(): string | null {
    return this.#text;
  }

  setText(text: string | null): void {
    this.#text = text;
    this.mesh.visible = text !== null;
    this.#redraw();
  }

  #redraw(): void {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    ctx.clearRect(0, 0, width, height);
    if (this.#text === null) {
      this.#texture.needsUpdate = true;
      return;
    }
    paintStatus(ctx, this.#text, width, height);
    this.#texture.needsUpdate = true;
  }
}
