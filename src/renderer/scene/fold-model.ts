import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface ScreenExtras {
  punchHole: [number, number, number];
  cornerRadiusUv: [number, number];
  pixelSize: [number, number];
}

const HINGE_AXIS = new THREE.Vector3(0, 1, 0);
/** The width of InnerScreen's bend band across the hinge, from the model contract. */
const CREASE_BAND_MM = 6;

export interface CreaseBand {
  centreU: number;
  halfWidthU: number;
}

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

/** Fits u against x over the screen's vertices (u runs linearly across the flat active area) and reads it off at the hinge line. */
function creaseBandOf(mesh: THREE.Mesh, hinge: THREE.Object3D): CreaseBand {
  mesh.updateWorldMatrix(true, false);
  const hingeX = hinge.getWorldPosition(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld.clone().invert()).x;
  const positions = mesh.geometry.getAttribute("position");
  const uvs = mesh.geometry.getAttribute("uv");
  let n = 0, sx = 0, su = 0, sxx = 0, sxu = 0;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const u = uvs.getX(i);
    n++;
    sx += x;
    su += u;
    sxx += x * x;
    sxu += x * u;
  }
  const slope = (n * sxu - sx * su) / (n * sxx - sx * sx);
  const offset = (su - slope * sx) / n;
  return { centreU: slope * hingeX + offset, halfWidthU: Math.abs(slope) * (CREASE_BAND_MM / 1000 / 2) };
}

const corner = new THREE.Vector3();

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
  readonly #openRadius: number;
  readonly #creaseBand: CreaseBand;

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
    this.#creaseBand = creaseBandOf(this.inner.mesh, this.#hinge);
    this.#openRadius = this.#fixedBox.clone().union(rigidBox(this.#coverHalf, this.root)).getBoundingSphere(new THREE.Sphere()).radius;
  }

  /** Where the inner screen's crease runs, in its u coordinate. */
  creaseBand(): CreaseBand {
    return this.#creaseBand;
  }

  /** The bounding sphere radius of the open body, in metres. */
  openRadius(): number {
    return this.#openRadius;
  }

  /**
   * The world box of the current pose, from the two rigid halves' boxes
   * (sixteen corners) rather than the skinned screens, so it is cheap
   * enough to take every frame.
   */
  poseBox(target = new THREE.Box3()): THREE.Box3 {
    this.root.updateWorldMatrix(true, true);
    target.makeEmpty();
    expandByCorners(target, this.#fixedBox, this.root.matrixWorld);
    expandByCorners(target, this.#coverBoxInHinge, this.#hinge.matrixWorld);
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
