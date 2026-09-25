import * as THREE from "three";

const CANVAS_W = 512;
const CANVAS_H = 256;

export class StatusOverlay {
  readonly mesh: THREE.Mesh;

  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #texture: THREE.CanvasTexture;

  constructor() {
    this.#canvas = document.createElement("canvas");
    this.#canvas.width = CANVAS_W;
    this.#canvas.height = CANVAS_H;
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.#ctx = ctx;
    this.#texture = new THREE.CanvasTexture(this.#canvas);
    const material = new THREE.MeshBasicMaterial({ map: this.#texture, transparent: true, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.visible = false;
  }

  applySize(w: number, h: number): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(w, h);
  }

  setText(text: string | null): void {
    if (text === null) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const ctx = this.#ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "white";
    ctx.font = "bold 40px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2, CANVAS_W - 40);
    this.#texture.needsUpdate = true;
  }
}
