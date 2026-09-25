import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { MaterialLook } from "../../shared/colourways";
import type { ScreenClass, ScreenKind } from "../../shared/fold7";
import type { DirectorOutput, FoldDirector } from "../../shared/fold-director";
import type { Rotation } from "../../shared/screen-uv";
import { StatusOverlay } from "../status-overlay";
import type { FrameTarget } from "../texture-renderer";
import { FoldModel, type ScreenExtras } from "./fold-model";
import { FrameLifecycle } from "./frame-lifecycle";
import { ScreenMaterial } from "./screen-material";
import { ScreenRouting } from "./screen-routing";

const MAX_TICK_MS = 1000;
const BADGE_SIZE_MM = { w: 9, h: 2.6 };
const BADGE_LIFT_MM = 0.4;
const SCREENS: ScreenKind[] = ["cover", "inner"];

/**
 * The stream is usually drawn smaller than its own resolution, which plain
 * linear filtering aliases; three regenerates the mip chain on every frame
 * upload.
 */
function videoTexture(frame?: VideoFrame): THREE.VideoFrameTexture {
  const texture = new THREE.VideoFrameTexture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  if (frame) texture.setFrame(frame);
  return texture;
}

function badgeSprite(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 52;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.font = "bold 38px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Flex", canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, toneMapped: false }));
  sprite.scale.set(BADGE_SIZE_MM.w / 1000, BADGE_SIZE_MM.h / 1000, 1);
  sprite.visible = false;
  return sprite;
}

function boxInFrameOf(frame: THREE.Object3D, object: THREE.Object3D): THREE.Box3 {
  frame.updateWorldMatrix(true, true);
  const worldToFrame = frame.matrixWorld.clone().invert();
  return new THREE.Box3().setFromObject(object).applyMatrix4(worldToFrame);
}

const SMOOTH_FRAME_COUNT = 10;
const SMOOTH_FRAME_GAP_MS = 100;
const SMOOTH_FRAMES_CAP_MS = 10_000;

/**
 * Resolves once animation frames arrive steadily again, or after the cap
 * (animation frames stop altogether while the window is hidden). A software
 * GL keeps building pipelines in the GPU process well after the first draw,
 * which stalls the compositor (and the video decoder behind it) for seconds.
 */
function smoothFrames(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(cap);
      resolve();
    };
    const cap = setTimeout(finish, SMOOTH_FRAMES_CAP_MS);
    let last = performance.now();
    let steady = 0;
    const tick = (now: number) => {
      if (done) return;
      steady = now - last < SMOOTH_FRAME_GAP_MS ? steady + 1 : 0;
      last = now;
      if (steady >= SMOOTH_FRAME_COUNT) finish();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function isSoftwareGl(): boolean {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return false;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return /swiftshader|llvmpipe|softpipe|software/i.test(name);
}

/** CSS anchoring that keeps the fixed half's outer edge in place while the canvas waits to follow a window resize. */
function anchorCanvas(canvas: HTMLCanvasElement, rotation: Rotation): void {
  const s = canvas.style;
  s.position = "fixed";
  s.left = s.right = s.top = s.bottom = "";
  if (rotation === 1 || rotation === 3) {
    s.left = "50%";
    s.transform = "translateX(-50%)";
    if (rotation === 1) s.top = "0";
    else s.bottom = "0";
  } else {
    s.top = "50%";
    s.transform = "translateY(-50%)";
    if (rotation === 0) s.right = "0";
    else s.left = "0";
  }
}

export interface PhoneSceneOptions {
  loadModel: () => Promise<ArrayBuffer>;
  onTick?: (out: DirectorOutput, rotation: Rotation) => void;
}

/**
 * The phone model in an orthographic work view at a fixed physical scale,
 * posed every animation frame by the FoldDirector. The live stream texture
 * sits on whichever screen the stream belongs to; a screen losing the stream
 * keeps a clone of its last frame until its fade-out ends.
 */
export class PhoneScene implements FrameTarget {
  disposed = false;
  /**
   * Settles once the model is on screen with every shader compiled (or it
   * failed to load); on a software GL also once the warm-up draws are done
   * and frames arrive steadily.
   */
  readonly ready: Promise<void>;

  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1);
  readonly #pivot = new THREE.Group();
  readonly #overlayScene = new THREE.Scene();
  readonly #overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  readonly #overlay = new StatusOverlay();
  readonly #live = videoTexture();
  readonly #frames = new FrameLifecycle<ScreenKind>(() => this.#renderNow());
  readonly #routing = new ScreenRouting();
  readonly #director: FoldDirector;
  readonly #onTick: (out: DirectorOutput, rotation: Rotation) => void;
  readonly #cloneTextures = new Map<ScreenKind, THREE.VideoFrameTexture>();

  #model: FoldModel | null = null;
  #materials: Record<ScreenKind, ScreenMaterial> | null = null;
  #badge: THREE.Sprite | null = null;
  #fixedEdgeX = 0;
  #bodyCentreY = 0;
  #pxPerMm = 1;
  #viewport = { w: 1, h: 1 };
  #rotation: Rotation = 0;
  #angle: number | null = null;
  #out: DirectorOutput | null = null;
  #lastTime: number | null = null;
  #frameDirty = true;
  #layoutDirty = true;
  #renderedSettled = false;
  #fatalStatus: string | null = null;
  #colourway: Record<string, MaterialLook> | null = null;
  readonly #software: boolean;

  constructor(canvasParent: HTMLElement, director: FoldDirector, options: PhoneSceneOptions) {
    this.#director = director;
    this.#onTick = options.onTick ?? (() => {});
    const software = isSoftwareGl();
    this.#software = software;
    this.#renderer = new THREE.WebGLRenderer({ antialias: !software, alpha: true });
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.autoClear = false;
    canvasParent.appendChild(this.#renderer.domElement);

    this.#light(software);
    this.#scene.add(this.#pivot);
    this.#camera.position.z = 0.5;

    this.#overlay.mesh.renderOrder = 1;
    this.#overlayScene.add(this.#overlay.mesh);

    this.#viewport = { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) };
    window.addEventListener("resize", () => this.resize(window.innerWidth, window.innerHeight));

    this.ready = options
      .loadModel()
      .then((data) => FoldModel.load(data))
      .then((model) => this.#attach(model))
      .catch((e: unknown) => {
        console.error("failed to load fold7.glb", e);
        this.#fatalStatus = `Could not load the phone model: ${e instanceof Error ? e.message : String(e)}`;
        this.setStatus(null);
      });

    this.#renderer.setAnimationLoop((time) => this.#animationFrame(time));
  }

  /**
   * The room environment makes the dark body read as glass and metal, but on
   * a software rasterizer it (like MSAA) costs seconds per frame, so there
   * the model is lit by two plain lights instead.
   */
  #light(software: boolean): void {
    if (software) {
      this.#scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 2));
      const key = new THREE.DirectionalLight(0xffffff, 2);
      key.position.set(-1, 1, 2);
      this.#scene.add(key);
      return;
    }
    const pmrem = new THREE.PMREMGenerator(this.#renderer);
    this.#scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  setFrame(frame: VideoFrame): void {
    this.#frames.setFrame(frame);
    this.#live.setFrame(frame);
    this.#frameDirty = true;
  }

  end(): void {
    this.#frames.end();
  }

  /** Called on every stream class announcement, after the director has heard it. */
  streamClass(cls: ScreenClass): void {
    const handoff = this.#routing.streamClass(cls);
    if (handoff) this.#handOff(handoff.from, handoff.to);
  }

  /** Called when the first frame of the current stream class has been set. */
  firstFrameOfClass(): void {
    this.#routing.firstFrame();
  }

  setPxPerMm(pxPerMm: number): void {
    this.#pxPerMm = pxPerMm;
    this.#layoutDirty = true;
  }

  resize(w: number, h: number): void {
    this.#viewport = { w: Math.max(1, w), h: Math.max(1, h) };
    this.#layoutDirty = true;
  }

  /** A model load failure stays on screen over any later status until the app restarts. */
  setStatus(text: string | null): void {
    this.#overlay.setText(this.#fatalStatus ?? text);
    this.#layoutDirty = true;
  }

  /** Applied now if the model is loaded, otherwise as soon as it is. */
  setColourway(looks: Record<string, MaterialLook>): void {
    this.#colourway = looks;
    this.#model?.applyColourway(looks);
    this.#frameDirty = true;
  }

  /** The active area of a screen in millimetres, or null before the model loads. */
  screenSizeMm(screen: ScreenKind): { w: number; h: number } | null {
    return this.#model?.screenSizeMm(screen) ?? null;
  }

  camera(): THREE.OrthographicCamera {
    return this.#camera;
  }

  /** The screen showing the stream, or null before the model or a stream and while the lit inner screen is folded away. */
  litScreen(): { mesh: THREE.Mesh; extras: ScreenExtras } | null {
    const out = this.#out;
    const screen = out?.lit ?? null;
    if (!this.#model || !out || !screen) return null;
    if (screen === "inner" && !out.innerVisible) return null;
    return this.#model[screen];
  }

  rotation(): Rotation {
    return this.#rotation;
  }

  output(): DirectorOutput | null {
    return this.#out;
  }

  async #attach(model: FoldModel): Promise<void> {
    this.#model = model;
    if (this.#colourway) model.applyColourway(this.#colourway);
    this.#materials = { cover: new ScreenMaterial(model.cover.extras), inner: new ScreenMaterial(model.inner.extras) };
    model.cover.mesh.material = this.#materials.cover;
    model.inner.mesh.material = this.#materials.inner;
    const videoScreen = this.#routing.videoScreen;
    if (videoScreen) this.#materials[videoScreen].setVideo(this.#live);

    model.setAngle(180);
    const fixed = boxInFrameOf(model.root, model.fixedHalf);
    this.#fixedEdgeX = fixed.max.x;
    this.#bodyCentreY = (fixed.min.y + fixed.max.y) / 2;
    this.#badge = this.#placeBadge(model);
    this.#angle = null;

    this.#pivot.add(model.root);
    this.#layoutDirty = true;
    await this.#precompile(model);
    if (this.#software) {
      this.#warmUp(model);
      await smoothFrames();
    }
  }

  /**
   * Compiles every program the scene can need while all of it is visible
   * (three skips hidden objects) and waits for each to link, so the stream's
   * first frames are not held up by compilation, which on a software GL
   * takes seconds.
   */
  async #precompile(model: FoldModel): Promise<void> {
    const candidates: (THREE.Object3D | null)[] = [this.#badge, this.#overlay.mesh];
    const hidden = candidates.filter((o): o is THREE.Object3D => o !== null && !o.visible);
    for (const o of hidden) o.visible = true;
    model.setInnerVisible(true);
    this.#applyLayout();
    await this.#renderer.compileAsync(this.#scene, this.#camera);
    await this.#renderer.compileAsync(this.#overlayScene, this.#overlayCamera);
    for (const program of this.#renderer.info.programs ?? []) program.getUniforms();
    for (const o of hidden) o.visible = false;
    this.#overlay.mesh.visible = this.#overlay.text !== null;
    this.#layoutDirty = true;
  }

  /**
   * Draws the model folded, half open and open with a video frame on both
   * screens, so a software GL builds its per-state draw and sampling
   * routines here instead of stalling the first seconds of the stream.
   */
  #warmUp(model: FoldModel): void {
    const materials = this.#materials;
    if (!materials) return;
    const size = 16;
    const black = new Uint8Array((size * size * 3) / 2).fill(128);
    black.fill(16, 0, size * size);
    const frame = new VideoFrame(black, { format: "I420", codedWidth: size, codedHeight: size, timestamp: 0 });
    const texture = videoTexture(frame);
    for (const screen of SCREENS) {
      materials[screen].setVideo(texture);
      materials[screen].setBrightness(1);
    }
    for (const angle of [180, 90, 0]) {
      model.setAngle(angle);
      this.#renderer.clear();
      this.#renderer.render(this.#scene, this.#camera);
    }
    for (const screen of SCREENS) {
      const held = this.#cloneTextures.get(screen) ?? null;
      materials[screen].setVideo(this.#routing.videoScreen === screen ? this.#live : held);
      materials[screen].setBrightness(0);
    }
    texture.dispose();
    frame.close();
    this.#angle = null;
  }

  #placeBadge(model: FoldModel): THREE.Sprite {
    const screen = boxInFrameOf(model.fixedHalf, model.inner.mesh);
    const bezel = boxInFrameOf(model.fixedHalf, model.inner.mesh.parent ?? model.inner.mesh);
    const badge = badgeSprite();
    badge.position.set(screen.max.x / 2, (screen.max.y + bezel.max.y) / 2, screen.max.z + BADGE_LIFT_MM / 1000);
    model.fixedHalf.add(badge);
    return badge;
  }

  #handOff(from: ScreenKind | null, to: ScreenKind): void {
    this.#releaseClone(to);
    this.#materials?.[to].setVideo(this.#live);
    if (!from) return;
    const clone = this.#frames.holdClone(from);
    const texture = clone ? videoTexture(clone) : null;
    if (texture) this.#cloneTextures.set(from, texture);
    this.#materials?.[from].setVideo(texture);
    this.#frameDirty = true;
  }

  #releaseClone(screen: ScreenKind): void {
    const texture = this.#cloneTextures.get(screen);
    if (texture) {
      if (this.#materials?.[screen].video() === texture) this.#materials[screen].setVideo(null);
      texture.dispose();
      this.#cloneTextures.delete(screen);
    }
    this.#frames.releaseClone(screen);
  }

  #animationFrame(time: number): void {
    const dt = this.#lastTime === null ? 0 : Math.min(MAX_TICK_MS, Math.max(0, time - this.#lastTime));
    this.#lastTime = time;
    const out = this.#director.tick(dt);
    this.#out = out;
    const rotation = this.#routing.rotation(out.rotation);
    if (rotation !== this.#rotation) {
      this.#rotation = rotation;
      this.#layoutDirty = true;
    }
    this.#pose(out, rotation);
    for (const screen of SCREENS) {
      if (this.#cloneTextures.has(screen) && this.#brightness(out, screen) === 0) this.#releaseClone(screen);
    }
    this.#onTick(out, rotation);

    // The tick that settles still moved the pose (the last fade step, the
    // snap onto the target angle), so skipping starts only after it is drawn.
    if (out.settled && this.#renderedSettled && !this.#frameDirty && !this.#layoutDirty) return;
    if (this.#layoutDirty) this.#applyLayout();
    this.#frameDirty = false;
    this.#layoutDirty = false;
    this.#renderedSettled = out.settled;
    this.#renderNow();
  }

  #brightness(out: DirectorOutput, screen: ScreenKind): number {
    return screen === "cover" ? out.coverBrightness : out.innerBrightness;
  }

  #pose(out: DirectorOutput, rotation: Rotation): void {
    const model = this.#model;
    const materials = this.#materials;
    if (!model || !materials) return;
    if (out.angle !== this.#angle) {
      model.setAngle(out.angle);
      this.#angle = out.angle;
    }
    model.setInnerVisible(out.innerVisible);
    materials.cover.setBrightness(out.coverBrightness);
    materials.inner.setBrightness(out.innerBrightness);
    const videoScreen = this.#routing.videoScreen;
    if (videoScreen) materials[videoScreen].setRotation(rotation);
    if (this.#badge) {
      this.#badge.visible = out.badge === "flex";
      this.#badge.material.rotation = (rotation * Math.PI) / 2;
    }
  }

  #applyLayout(): void {
    const { w, h } = this.#viewport;
    this.#renderer.setPixelRatio(window.devicePixelRatio);
    this.#renderer.setSize(w, h);
    anchorCanvas(this.#renderer.domElement, this.#rotation);

    const metresPerPx = 1 / (this.#pxPerMm * 1000);
    const halfW = (w * metresPerPx) / 2;
    const halfH = (h * metresPerPx) / 2;
    this.#camera.left = -halfW;
    this.#camera.right = halfW;
    this.#camera.top = halfH;
    this.#camera.bottom = -halfH;
    this.#camera.updateProjectionMatrix();

    this.#pivot.rotation.z = (this.#rotation * Math.PI) / 2;
    if (this.#model) {
      const sideways = this.#rotation === 1 || this.#rotation === 3;
      const alongX = sideways ? 2 * halfH : 2 * halfW;
      this.#model.root.position.set(-(this.#fixedEdgeX - alongX / 2), -this.#bodyCentreY, 0);
    }

    this.#overlayCamera.left = -w / 2;
    this.#overlayCamera.right = w / 2;
    this.#overlayCamera.top = h / 2;
    this.#overlayCamera.bottom = -h / 2;
    this.#overlayCamera.updateProjectionMatrix();
  }

  /** Lays the status overlay over the screen the stream is on (the cover before any stream), upright on screen. */
  #placeOverlay(): void {
    if (!this.#overlay.mesh.visible) return;
    const { w, h } = this.#viewport;
    const screen = this.#out?.lit ?? this.#routing.videoScreen ?? "cover";
    const mesh = this.#model?.[screen].mesh;
    if (!mesh) {
      this.#overlay.applySize(w, h);
      this.#overlay.mesh.position.set(0, 0, 0);
      return;
    }
    const skinned = mesh as THREE.SkinnedMesh;
    let box: THREE.Box3;
    if (skinned.isSkinnedMesh) {
      skinned.computeBoundingBox();
      box = skinned.boundingBox!.clone().applyMatrix4(skinned.matrixWorld);
    } else {
      box = new THREE.Box3().setFromObject(mesh);
    }
    const projected = new THREE.Box2();
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        const ndc = new THREE.Vector3(x, y, box.max.z).project(this.#camera);
        projected.expandByPoint(new THREE.Vector2((ndc.x * w) / 2, (ndc.y * h) / 2));
      }
    }
    const size = projected.getSize(new THREE.Vector2());
    const centre = projected.getCenter(new THREE.Vector2());
    this.#overlay.applySize(Math.max(1, Math.round(size.x)), Math.max(1, Math.round(size.y)));
    this.#overlay.mesh.position.set(centre.x, centre.y, 0);
  }

  #renderNow(): void {
    this.#scene.updateMatrixWorld();
    this.#renderer.clear();
    this.#renderer.render(this.#scene, this.#camera);
    this.#frames.onRendered();
    if (this.#overlay.mesh.visible) {
      this.#placeOverlay();
      this.#renderer.clearDepth();
      this.#renderer.render(this.#overlayScene, this.#overlayCamera);
    }
  }
}
