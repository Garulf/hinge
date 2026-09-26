import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { MaterialLook } from "../../shared/colourways";

export interface ScreenExtras {
  punchHole: [number, number, number];
  cornerRadiusUv: [number, number];
  pixelSize: [number, number];
}

const HINGE_AXIS = new THREE.Vector3(0, 1, 0);
function requireNode(root: THREE.Object3D, name: string): THREE.Object3D {
  const node = root.getObjectByName(name);
  if (!node) throw new Error(`fold7.glb has no node named ${name}`);
  return node;
}

function screenPrimitive(node: THREE.Object3D, materialName: string): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  node.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.name === materialName) found = mesh;
  });
  if (!found) throw new Error(`${node.name} has no ${materialName} primitive`);
  return found;
}

function screenExtras(node: THREE.Object3D): ScreenExtras {
  const { punchHole, cornerRadiusUv, pixelSize } = node.userData as Partial<ScreenExtras>;
  if (!punchHole || !cornerRadiusUv || !pixelSize) throw new Error(`${node.name} is missing its screen extras`);
  return { punchHole, cornerRadiusUv, pixelSize };
}

/** The box of an object's non-skinned meshes in the frame of `frame`; skinned meshes span both halves. */
function rigidBox(object: THREE.Object3D, frame: THREE.Object3D): THREE.Box3 {
  frame.updateWorldMatrix(true, true);
  const worldToFrame = frame.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(worldToFrame, mesh.matrixWorld)));
  });
  return box;
}

const corner = new THREE.Vector3();
const worldToFrame = new THREE.Matrix4();
const toFrame = new THREE.Matrix4();

function expandByCorners(target: THREE.Box3, box: THREE.Box3, matrix: THREE.Matrix4): void {
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    target.expandByPoint(corner.applyMatrix4(matrix));
  }
}

function parseGltf(data: ArrayBuffer): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(data, "", (gltf) => resolve(gltf.scene), reject);
  });
}

export class FoldModel {
  readonly root: THREE.Object3D;
  readonly fixedHalf: THREE.Object3D;
  readonly cover: { mesh: THREE.Mesh; extras: ScreenExtras };
  readonly inner: { mesh: THREE.SkinnedMesh; extras: ScreenExtras };

  readonly #coverHalf: THREE.Object3D;
  readonly #hinge: THREE.Object3D;
  readonly #boneCover: THREE.Object3D;
  readonly #innerScreen: THREE.Object3D;
  readonly #skinned: THREE.SkinnedMesh[] = [];
  readonly #fixedBox: THREE.Box3;
  readonly #coverBoxInHinge: THREE.Box3;

  static async load(data: ArrayBuffer): Promise<FoldModel> {
    return new FoldModel(await parseGltf(data));
  }

  private constructor(scene: THREE.Object3D) {
    this.root = requireNode(scene, "Root");
    this.fixedHalf = requireNode(this.root, "FixedHalf");
    this.#coverHalf = requireNode(this.root, "CoverHalf");
    this.#hinge = requireNode(this.root, "Hinge");
    this.#boneCover = requireNode(this.root, "bone_cover");
    this.#innerScreen = requireNode(this.root, "InnerScreen");
    requireNode(this.root, "HingeFill");
    requireNode(this.root, "bone_fixed");
    requireNode(this.root, "Rig");

    const coverScreen = requireNode(this.root, "CoverScreen");
    this.cover = { mesh: screenPrimitive(coverScreen, "screen_cover"), extras: screenExtras(coverScreen) };
    const innerMesh = screenPrimitive(this.#innerScreen, "screen_inner");
    if (!(innerMesh as THREE.SkinnedMesh).isSkinnedMesh) throw new Error("InnerScreen is not skinned");
    this.inner = { mesh: innerMesh as THREE.SkinnedMesh, extras: screenExtras(this.#innerScreen) };

    this.root.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) {
        // The bounds three caches for a skinned mesh are taken in whatever
        // pose it first saw, so the folded crease would be culled or missed
        // by raycasts; setAngle() drops them instead.
        skinned.frustumCulled = false;
        this.#skinned.push(skinned);
      }
    });
    this.setAngle(180);
    this.#fixedBox = rigidBox(this.fixedHalf, this.root);
    this.#coverBoxInHinge = rigidBox(this.#coverHalf, this.#hinge);
  }

  /**
   * The box of the current pose, from the two rigid halves' boxes (sixteen
   * corners) rather than the skinned screens, so it is cheap enough to take
   * every frame. In world space, or in the local space of an ancestor
   * `frame`: taken through the matrices below that frame only, so the
   * frame's own transform, even a stale world matrix of a frame whose
   * matrix is set by hand, cannot leak into it.
   */
  poseBox(target = new THREE.Box3(), frame?: THREE.Object3D): THREE.Box3 {
    this.root.updateWorldMatrix(true, true);
    target.makeEmpty();
    if (frame) worldToFrame.copy(frame.matrixWorld).invert();
    const inFrame = (matrixWorld: THREE.Matrix4) => (frame ? toFrame.multiplyMatrices(worldToFrame, matrixWorld) : matrixWorld);
    expandByCorners(target, this.#fixedBox, inFrame(this.root.matrixWorld));
    expandByCorners(target, this.#coverBoxInHinge, inFrame(this.#hinge.matrixWorld));
    return target;
  }

  setAngle(degrees: number): void {
    const radians = THREE.MathUtils.degToRad(-degrees);
    this.#hinge.quaternion.setFromAxisAngle(HINGE_AXIS, radians);
    this.#boneCover.quaternion.setFromAxisAngle(HINGE_AXIS, radians);
    this.root.updateMatrixWorld(true);
    for (const mesh of this.#skinned) {
      const bounds = mesh as unknown as { boundingBox: THREE.Box3 | null; boundingSphere: THREE.Sphere | null };
      bounds.boundingBox = null;
      bounds.boundingSphere = null;
    }
  }

  /** Restyles every material named in `looks`; the loader shares one material per glTF material, so each is set once. */
  applyColourway(looks: Record<string, MaterialLook>): void {
    const seen = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const look = looks[material.name];
        if (!look || seen.has(material) || !(material instanceof THREE.MeshStandardMaterial)) continue;
        seen.add(material);
        material.color.set(look.baseColor);
        material.metalness = look.metallic;
        material.roughness = look.roughness;
      }
    });
  }

  /** The active area of a screen in millimetres, flat (the inner screen's rest pose is open). */
  screenSizeMm(screen: "cover" | "inner"): { w: number; h: number } {
    const geometry = this[screen].mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    return { w: size.x * 1000, h: size.y * 1000 };
  }

  setInnerVisible(visible: boolean): void {
    this.#innerScreen.visible = visible;
  }

  bodyWidthMm(): number {
    this.root.updateWorldMatrix(true, true);
    const box = this.#boxInRootFrame(this.fixedHalf).union(this.#boxInRootFrame(this.#coverHalf));
    return (box.max.x - box.min.x) * 1000;
  }

  #boxInRootFrame(object: THREE.Object3D): THREE.Box3 {
    const worldToRoot = this.root.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let local: THREE.Box3;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        (mesh as THREE.SkinnedMesh).computeBoundingBox();
        local = (mesh as THREE.SkinnedMesh).boundingBox!;
      } else {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        local = mesh.geometry.boundingBox!;
      }
      box.union(local.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(worldToRoot, mesh.matrixWorld)));
    });
    return box;
  }
}
