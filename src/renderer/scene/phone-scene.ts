import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { WorkLayout } from "../../shared/layout";
import { StatusOverlay } from "../status-overlay";
import type { FrameTarget } from "../texture-renderer";
import { FrameLifecycle } from "./frame-lifecycle";

const SLAB_DEPTH = 10;
const SCREEN_Z = 6;
const OVERLAY_Z = 7;

export class PhoneScene implements FrameTarget {
  disposed = false;

  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera: THREE.OrthographicCamera;
  readonly #videoTexture: THREE.VideoFrameTexture;
  readonly #slab: THREE.Mesh;
  readonly #screen: THREE.Mesh;
  readonly #overlay: StatusOverlay;
  readonly #frames: FrameLifecycle;
  #dirty = true;

  constructor(canvasParent: HTMLElement) {
    this.#frames = new FrameLifecycle(() => this.#renderNow());
    this.#renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    canvasParent.appendChild(this.#renderer.domElement);

    this.#camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 1000);
    this.#camera.position.z = 500;

    this.#videoTexture = new THREE.VideoFrameTexture();
    this.#videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.#videoTexture.minFilter = THREE.LinearFilter;
    this.#videoTexture.magFilter = THREE.LinearFilter;
    this.#videoTexture.generateMipmaps = false;

    this.#slab = new THREE.Mesh(new RoundedBoxGeometry(1, 1, SLAB_DEPTH, 2, 0.1), new THREE.MeshBasicMaterial({ color: 0x1b1c1e }));
    this.#scene.add(this.#slab);

    this.#screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.#videoTexture, toneMapped: false }),
    );
    this.#screen.position.z = SCREEN_Z;
    this.#scene.add(this.#screen);

    this.#overlay = new StatusOverlay();
    this.#overlay.mesh.position.z = OVERLAY_Z;
    this.#scene.add(this.#overlay.mesh);

    this.#renderer.setAnimationLoop(() => this.#renderFrame());
  }

  setFrame(frame: VideoFrame): void {
    this.#frames.setFrame(frame);
    this.#videoTexture.setFrame(frame);
    this.#dirty = true;
  }

  end(): void {
    this.#frames.end();
  }

  applyLayout(layout: WorkLayout): void {
    this.#renderer.setPixelRatio(window.devicePixelRatio);
    this.#renderer.setSize(layout.window.w, layout.window.h);

    this.#camera.left = -layout.window.w / 2;
    this.#camera.right = layout.window.w / 2;
    this.#camera.top = layout.window.h / 2;
    this.#camera.bottom = -layout.window.h / 2;
    this.#camera.updateProjectionMatrix();

    this.#slab.geometry.dispose();
    this.#slab.geometry = new RoundedBoxGeometry(layout.window.w, layout.window.h, SLAB_DEPTH, 2, 6 * layout.pxPerMm);

    this.#screen.geometry.dispose();
    this.#screen.geometry = new THREE.PlaneGeometry(layout.screen.w, layout.screen.h);
    const screenCenterX = layout.screen.x + layout.screen.w / 2 - layout.window.w / 2;
    const screenCenterY = layout.window.h / 2 - (layout.screen.y + layout.screen.h / 2);
    this.#screen.position.set(screenCenterX, screenCenterY, SCREEN_Z);

    this.#overlay.applySize(layout.screen.w, layout.screen.h);
    this.#overlay.mesh.position.set(screenCenterX, screenCenterY, OVERLAY_Z);

    this.#dirty = true;
  }

  screenMesh(): THREE.Mesh {
    return this.#screen;
  }

  camera(): THREE.OrthographicCamera {
    return this.#camera;
  }

  setStatus(text: string | null): void {
    this.#overlay.setText(text);
    this.#dirty = true;
  }

  #renderFrame(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#renderNow();
  }

  #renderNow(): void {
    this.#renderer.render(this.#scene, this.#camera);
    this.#frames.onRendered();
  }
}
