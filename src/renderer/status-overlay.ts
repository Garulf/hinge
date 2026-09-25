import * as THREE from "three";
import { wrapText } from "./wrap-text";

export class StatusOverlay {
  readonly mesh: THREE.Mesh;

  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #texture: THREE.CanvasTexture;
  #text: string | null = null;

  constructor() {
    this.#canvas = document.createElement("canvas");
    this.#canvas.width = 1;
    this.#canvas.height = 1;
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.#ctx = ctx;
    this.#texture = new THREE.CanvasTexture(this.#canvas);
    const material = new THREE.MeshBasicMaterial({ map: this.#texture, transparent: true, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.visible = false;
  }

  /** Sizes the backing canvas to the screen rect's own aspect ratio and DPR, not a fixed 2:1 box. */
  applySize(w: number, h: number): void {
    const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const pixelW = Math.max(1, Math.round(w * dpr));
    const pixelH = Math.max(1, Math.round(h * dpr));
    if (this.#canvas.width !== pixelW || this.#canvas.height !== pixelH) {
      this.#canvas.width = pixelW;
      this.#canvas.height = pixelH;
    }
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(w, h);
    this.#redraw();
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
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontSize = Math.max(12, Math.round(height * 0.05));
    ctx.font = `bold ${fontSize}px sans-serif`;
    const maxWidth = width * 0.85;
    const lines = wrapText((s) => ctx.measureText(s).width, this.#text, maxWidth);
    const lineHeight = fontSize * 1.3;
    const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], width / 2, startY + i * lineHeight, maxWidth);
    this.#texture.needsUpdate = true;
  }
}
