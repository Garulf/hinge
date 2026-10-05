import * as THREE from "three";
import type { Credential, UnlockRequest, UnlockResult } from "../../shared/lock";
import { backingSize, type OverlayCanvas, type OverlayTexture } from "../status-overlay";
import { hitAt, hitCentre, unlockLayout, type HitId, type UnlockLayout } from "./unlock-layout";
import { UnlockModel, type KeyLike, type UnlockView } from "./unlock-model";
import { animating, paintUnlock } from "./unlock-paint";

export interface UnlockOverlayOptions {
  submit(request: UnlockRequest): void;
  /** Closed by the user (Cancel or Escape). */
  cancelled(): void;
  /** Shown, hidden or redrawn: the scene must draw it again. */
  changed(): void;
  opened?(): void;
  canvas?: OverlayCanvas;
  makeTexture?: (canvas: OverlayCanvas) => OverlayTexture;
  now?: () => number;
}

/** hinge's own PIN or password pad, laid over the lit screen by PhoneScene like the status text. */
export class UnlockOverlay {
  readonly mesh: THREE.Mesh;
  readonly #opts: UnlockOverlayOptions;
  readonly #canvas: OverlayCanvas;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #makeTexture: (canvas: OverlayCanvas) => OverlayTexture;
  readonly #now: () => number;
  readonly #model: UnlockModel;
  #texture: OverlayTexture;
  #size = { w: 0, h: 0 };
  #layout: UnlockLayout | null = null;

  constructor(opts: UnlockOverlayOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => performance.now());
    this.#canvas = opts.canvas ?? document.createElement("canvas");
    this.#canvas.width = 1;
    this.#canvas.height = 1;
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.#ctx = ctx;
    this.#makeTexture = opts.makeTexture ?? ((canvas) => new THREE.CanvasTexture(canvas as HTMLCanvasElement));
    this.#texture = this.#makeTexture(this.#canvas);
    const material = new THREE.MeshBasicMaterial({ map: this.#texture as unknown as THREE.Texture, transparent: true, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.visible = false;
    this.#model = new UnlockModel({
      submit: (request) => opts.submit(request),
      cancel: () => {
        this.close();
        opts.cancelled();
      },
      now: this.#now,
    });
  }

  isOpen(): boolean {
    return this.mesh.visible;
  }

  open(credential: Credential): void {
    this.#model.open(credential);
    this.mesh.visible = true;
    this.#relayout();
    this.#opts.opened?.();
  }

  close(): void {
    if (!this.mesh.visible) return;
    this.mesh.visible = false;
    this.#model.clear();
    this.#opts.changed();
  }

  result(result: UnlockResult): void {
    if (!this.isOpen()) return;
    if (this.#model.result(result) === "close") this.close();
    else this.#relayout();
  }

  /** Same texture handling as StatusOverlay.applySize: three sizes a CanvasTexture once, so a new pixel size needs a new texture. */
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
    this.#relayout();
  }

  pointerDown(u: number, v: number): void {
    this.#model.pressDown(this.#hit(u, v));
    this.#repaint();
  }

  pointerUp(at: { u: number; v: number } | null): void {
    this.#model.pressUp(at ? this.#hit(at.u, at.v) : null);
    this.#relayout();
  }

  key(e: KeyLike): boolean {
    const claimed = this.#model.key(e);
    if (claimed && this.isOpen()) this.#relayout();
    return claimed;
  }

  /** Called every animation frame; redraws only while the spinner turns or the entry shakes. */
  tick(now: number): void {
    if (this.isOpen() && animating(this.#model.view(), now)) this.#repaint();
  }

  view(): UnlockView {
    return this.#model.view();
  }

  hitPoint(id: HitId): { u: number; v: number } | null {
    if (!this.#layout || this.#size.w === 0) return null;
    const c = hitCentre(this.#layout, id);
    return c ? { u: c.x / this.#size.w, v: c.y / this.#size.h } : null;
  }

  #hit(u: number, v: number): HitId | null {
    return this.#layout ? hitAt(this.#layout, u * this.#size.w, v * this.#size.h) : null;
  }

  /** The mode or the switch link can change with any input, so the layout is rebuilt before each repaint that follows one. */
  #relayout(): void {
    const view = this.#model.view();
    this.#layout = unlockLayout(Math.max(1, this.#size.w), Math.max(1, this.#size.h), view.mode, this.#model.canSwitch());
    this.#repaint();
  }

  #repaint(): void {
    if (!this.isOpen() || !this.#layout) {
      this.#opts.changed();
      return;
    }
    const ctx = this.#ctx;
    const scale = this.#size.w > 0 ? this.#canvas.width / this.#size.w : 1;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    paintUnlock(ctx, this.#model.view(), this.#layout, this.#size, this.#now());
    this.#texture.needsUpdate = true;
    this.#opts.changed();
  }
}
